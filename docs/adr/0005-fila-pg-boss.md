# ADR-0005: Fila de jobs com pg-boss no próprio PostgreSQL

- **Status:** Proposto. O worker ainda não existe; o papel `app_worker` já existe no banco.
- **Data:** 2026-10-17
- **Relacionados:** [arquitetura, seção 7](../arquitetura.md#7-jobs-e-assincronia-planejado),
  [ADR-0006](0006-hospedagem-e-residencia.md)

## Contexto

O produto precisa de trabalho assíncrono e agendado:

- lembretes 24 h e 2 h antes;
- confirmações e cancelamentos por WhatsApp;
- expiração de holds de Pix a cada minuto;
- marcação opcional de no-show;
- retenção e anonimização (LGPD);
- exportações pesadas.

Dois requisitos guiam a escolha:

1. **Atomicidade:** criar o agendamento e enfileirar o lembrete precisa ser uma coisa só. Se
   a transação desfaz, o job some junto (ASVS 2.3.3).
2. **Residência:** o payload tem nome e telefone do cliente. Ele deve ficar no nosso banco em
   São Paulo.

Fatos verificados no registry npm e no repositório `timgit/pg-boss` em 16/10/2026:

- pg-boss 12.38.0 exige Node ≥ 22.12 e PostgreSQL ≥ 13.
- Recursos: `send` dentro de uma transação existente via adaptador (`fromDrizzle(tx, sql)`),
  `startAfter`, `singletonKey`, retry com backoff, DLQ com redrive, cron, `LISTEN/NOTIFY`,
  OpenTelemetry e dashboard opcional.
- Inngest e Trigger.dev Cloud: nenhuma região no Brasil foi encontrada (não verificado). Os
  dois disparam o evento depois do commit, o que exigiria um outbox.

## Decisão (proposta)

Usar **pg-boss** no mesmo PostgreSQL (schema `pgboss`), com um **worker long-running** em
processo separado (`apps/worker`, Node 24, no Fly.io `gru`).

- **Enfileirar na mesma transação** de `withTenant`.
- **Payload mínimo:** IDs e `tenantId`, sem nome, telefone ou texto livre. O worker lê o resto
  com `withTenant({ tenantId, actor: system })`. Job sem tenant é rejeitado.
- **Idempotência:**
  - `singletonKey` determinística (`reminder:<appointmentId>:24h`);
  - `dedupe_key` única por tenant na tabela de notificações, porque cada mensagem de WhatsApp
    é cobrada;
  - ao remarcar, cancelar e recriar os jobs.
- **Papel `app_worker`**: lê o tenant do job e só tem UPDATE de `appointments.status` e de
  `occupancies.active` (GRANT de coluna já existente; `active` é recalculada por trigger a
  partir do status). Expirar hold e marcar no-show cabem nisso. Job novo que precise escrever
  outra coluna ganha GRANT de coluna explícito numa migração nova e o ajuste em
  `assert_security_invariants()`, que hoje recusa INSERT, DELETE e UPDATE de tabela inteira
  para o `app_worker`. Precisa também dos privilégios no schema `pgboss`, o que exige o mesmo
  ajuste.
- **Conexão direta** (sem pooler em modo transação) para o worker, por causa de
  `LISTEN/NOTIFY` e conexões longas.
- **Saída de rede** do worker só por `safeFetch` (allowlist, sem redirect, bloqueio de IPs não
  públicos) ou por um proxy de egress.
- Uma instância do `PgBoss` por processo: `start()` no boot e `stop()` no `SIGTERM`.

## Consequências

- **Positivas:**
  - nenhum dado pessoal sai do Brasil para a fila;
  - zero infraestrutura extra além do PostgreSQL;
  - transação única entre agendamento e lembrete;
  - retries e DLQ prontos.
- **Negativas e riscos:**
  - processo extra para operar (deploy, health, escala);
  - a fila disputa recursos com o banco transacional, o que exige monitorar o tamanho das
    tabelas do pg-boss e a retenção dos jobs concluídos;
  - expirar holds de todos os tenants exige iterar por tenant ou uma função `SECURITY DEFINER`
    dedicada (decidir no threat model do worker).
- **Ações decorrentes:**
  - migração com o schema `pgboss` e os GRANTs, revisada pela skill `review-migration`;
  - testes de integração de enfileiramento transacional (rollback desfaz o job);
  - alerta de backlog e de DLQ.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Inngest | Dados na nuvem do fornecedor, sem região no Brasil encontrada. Sem atomicidade com o agendamento |
| Trigger.dev Cloud | Regiões vistas: `us-east-1` e `eu-central-1`. O self-host é possível, mas é mais um sistema |
| Fila em Redis (por exemplo BullMQ) | Outro datastore com PII, sem transação com o PostgreSQL. Exigiria um outbox |
| `pg_cron` + tabelas próprias | Reimplementar retry, DLQ e backoff. Disponibilidade variável entre provedores |
| Cron da Vercel chamando rotas | Sem fila, sem retry por job e com limite de duração das funções |

## Referências

- pg-boss: https://github.com/timgit/pg-boss (README, `docs/api/jobs.md`, `docs/api/adapters.md`)
- OWASP ASVS 5.0.0, requisito 2.3.3 (transações de negócio atômicas)
