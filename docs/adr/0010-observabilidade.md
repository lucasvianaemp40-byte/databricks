# ADR-0010: Observabilidade (logs, erros e eventos de segurança)

- **Status:** Aceito (decisão delegada pelo dono em 2026-10-19; revisável). Relida no aceite,
  sem mudança de conteúdo. Implementação na iteração 1, item T2 do
  [backlog](../produto/backlog-inicial.md#transversal-antes-ou-durante-o-mvp). Nada disto
  existe no código ainda. A fundação tem só as páginas de erro com `digest`, o
  `/api/health` mínimo, a auditoria `appointment_events` e a regra Semgrep `pii-in-logs`.
- **Data:** 2026-10-17
- **Relacionados:** [arquitetura, seção 9](../arquitetura.md#9-observabilidade-planejado),
  [ADR-0006](0006-hospedagem-e-residencia.md) (região do Sentry),
  [inventário de dados](../lgpd/inventario-de-dados.md), [retenção](../lgpd/retencao.md),
  [cabeçalhos e CSP](../seguranca/headers-e-csp.md)

## Contexto

Precisamos diagnosticar incidentes, registrar eventos de segurança (ASVS 5.0, 16.2 e 16.3) e
alertar sobre abuso (SMS pumping, exportação em massa, disputa de horário) sem levar dado
pessoal para logs, erros ou terceiros (LGPD; regra 5 do [CLAUDE.md](../../CLAUDE.md)).

As decisões estavam espalhadas:

- [arquitetura.md](../arquitetura.md), seção 9: pino com redaction, Sentry com
  `sendDefaultPii: false` e túnel, eventos de segurança e alertas;
- [ADR-0006](0006-hospedagem-e-residencia.md): Sentry na região UE se disponível;
- [inventário](../lgpd/inventario-de-dados.md) e [retenção](../lgpd/retencao.md): IP só em
  registro de acesso por 6 meses (Marco Civil, art. 15) e logs de segurança por 12 meses.

Fatos (registry npm e pesquisa de stack de 16/10/2026):

- versões estáveis: `@sentry/nextjs` 11.8.0, `pino` 10.4.0, `@opentelemetry/api` 1.9.1;
- `GHSA-6465-jgvq-jhgp`: com `sendDefaultPii: true`, o `@sentry/nextjs` de 10.11 a menor que
  10.27 enviava cabeçalhos sensíveis;
- a CSP tem `connect-src 'self'`. Mandar erros do navegador direto ao Sentry exigiria liberar
  o domínio dele e entregaria o IP do visitante a outro controlador;
- a regra Semgrep [`pii-in-logs`](../../.semgrep/rules/pii-in-logs.yml) já cobre `console.*`,
  `logger`, Sentry e analytics (inclusive os `console.*` de `packages/db`), mas não existe
  logger do projeto;
- o `DrizzleQueryError` que o `@salon/db` repassa (e que fica no `cause` dos erros traduzidos)
  traz os parâmetros da consulta na mensagem, que podem ser dado pessoal.

Não verificado: disponibilidade da região UE no plano do Sentry que contratarmos.

## Decisão

1. **Logs da aplicação com pino**, em JSON, com `time` ISO em UTC e os campos `requestId`,
   `tenantId`, `userId` (IDs opacos) e `event`. Um logger só por processo
   (`apps/web/src/server/logger.ts`; o worker terá o dele). Código de servidor não usa
   `console.*`.
   - Redaction por caminho (`redact` do pino), com censura e não remoção:
     `req.headers.cookie`, `req.headers.authorization`, `*.phone`, `*.phoneE164`, `*.email`,
     `*.otp`, `*.code`, `*.token`, `*.password`, `*.fullName`, `*.notes`.
   - Nunca registrar o corpo da requisição, o payload de webhook nem texto livre.
   - Erro do banco: registrar `name` e `code` do erro traduzido. Nunca o `DrizzleQueryError` cru
     nem o `cause`.
   - IP só nos registros de acesso (6 meses), não nos logs da aplicação.
2. **Erros com `@sentry/nextjs`**: `sendDefaultPii: false`; `beforeSend` com a mesma redaction;
   sem Session Replay; túnel na mesma origem (a CSP continua `connect-src 'self'`); região UE
   se disponível ([ADR-0006](0006-hospedagem-e-residencia.md)); source maps enviados no build e
   não servidos ao navegador. Inicialização pelos arquivos `instrumentation.ts` e
   `instrumentation-client.ts` do Next.
3. **Relatórios de CSP** (`report-to`) pelo mesmo caminho do Sentry, na mesma origem
   ([cabeçalhos e CSP](../seguranca/headers-e-csp.md#3-planejado-entra-com-autenticação-e-páginas-autenticadas)).
4. **Eventos de segurança** com nomes estáveis: `auth.*`, `authz.denied`, `ratelimit.hit`,
   `rls.violation` (`TenantIsolationError`), `slot.conflict` (`SlotUnavailableError`),
   `id.conflict` (`IdentifierConflictError`) e `tx.closed` (`TransactionClosedError`, que é
   bug de programação). Logs de segurança detalhados ficam 12 meses e depois só agregados.
5. **Alertas:** queda da razão entre OTPs verificados e enviados, exportações em massa,
   `authz.denied` por usuário, falhas de envio de lembrete, taxa de 409 na reserva, custo
   diário de mensagens por tenant, backlog e DLQ da fila.
6. **OpenTelemetry com exportador próprio: não agora.** O `@opentelemetry/api` só entra se for
   preciso rastrear uma operação entre o app e o worker. Até lá, Sentry e pino bastam.
7. **Critérios de aceite do T2** (nada disso na fundação):
   - teste de redaction do logger (telefone, e-mail, token, cookie, `authorization`) que falha
     antes da implementação;
   - casos `// ruleid:` e `// ok:` na fixture da regra `pii-in-logs` para o logger do projeto;
   - teste de que o `beforeSend` remove os mesmos campos;
   - nenhuma origem nova na CSP;
   - inventário de dados, retenção e checklist contratual atualizados (skill `lgpd-check`).

## Consequências

- **Positivas:**
  - uma decisão só para logs, erros, eventos e alertas;
  - minimização de dado pessoal desde o primeiro log;
  - CSP intacta e nenhum IP de visitante entregue direto a terceiro.
- **Negativas e riscos:**
  - o túnel passa os eventos pelas funções do app, o que custa invocações;
  - Sentry fora do Brasil é transferência internacional: exige cláusulas-padrão da ANPD (Res.
    CD/ANPD 19/2024) ou país com adequação. **A validar com jurídico;**
  - redaction por caminho não pega dado pessoal em texto livre. Por isso a regra é não logar
    texto livre, e a regra Semgrep `pii-in-logs` vigia as chamadas.
- **Ações decorrentes:**
  - implementar no T2, com threat model curto (skill `threat-model`);
  - incluir o Sentry na lista de suboperadores do
    [checklist contratual](../lgpd/checklist-contratual.md) ao contratar.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Sentry direto do navegador, sem túnel | Abre `connect-src` para o domínio do Sentry e entrega o IP do visitante a outro controlador |
| Só os logs do provedor (Vercel), sem Sentry | Sem agrupamento de erros nem alertas; o rastreio de incidente fica manual |
| OpenTelemetry com backend próprio desde o MVP | Mais um sistema para operar sem necessidade no MVP |
| `console.*` direto | Sem estrutura, sem `requestId` e sem redaction |

## Referências

- pino, `redact`: https://github.com/pinojs/pino/blob/main/docs/redaction.md
- Sentry para Next.js: https://docs.sentry.io/platforms/javascript/guides/nextjs/
- Next.js, `instrumentation.ts`: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
- Marco Civil da Internet (Lei 12.965/2014), art. 15:
  https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2014/lei/l12965.htm
- OWASP ASVS 5.0.0, capítulo V16: https://github.com/OWASP/ASVS/tree/v5.0.0_release/5.0
