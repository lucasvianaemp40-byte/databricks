# Modelo de ameaças do sistema

Modelo geral do Agenda Salão, revisado em 17/10/2026. Threat models de features específicas
ficam em [threat-models/](threat-models/README.md). A arquitetura de referência está em
[../arquitetura.md](../arquitetura.md).

- **Método:** STRIDE por componente para segurança e LINDDUN para privacidade. O risco é
  qualitativo: probabilidade × impacto, Alto/Médio/Baixo.
- **Status do controle:** **[fundação]** implementado e testado; **[planejado]** decidido, sem
  código; **[a decidir]** em aberto.
- **Regra:** ameaça sem teste que prove a mitigação continua aberta.

## 1. Atores

| Ator | Sigla | Confiança | Observação |
|---|---|---|---|
| Visitante anônimo | X | nenhuma | acessa a página pública de agendamento |
| Bot | B | nenhuma | automatiza reservas, OTP e scraping |
| Cliente final | C | baixa | autenticado por OTP (WhatsApp ou SMS), sessão de baixo privilégio |
| Profissional | P | média | vê a própria agenda; pode ser parceiro (Lei do Salão-Parceiro) |
| Recepção ou gerente | R | média | opera a agenda e os clientes do salão |
| Dono do salão | D | alta no próprio tenant | configura, exporta e gerencia a equipe |
| Suporte da plataforma | S | alta, com acesso excepcional | só com janela concedida pelo dono e auditada |
| Worker (`app_worker`) | W | sistema | processa jobs de um tenant por vez |
| Provedores (Meta, PSP, e-mail) | — | parcial | enviam webhooks, que são dado não confiável até a assinatura ser verificada |
| Agente de IA (Claude Code, CI) | IA | parcial | escreve código e roda comandos sob hooks e revisão humana |

## 2. Ativos

| Ativo | Por que importa |
|---|---|
| Dados pessoais de clientes (nome, telefone, e-mail, histórico) | LGPD; o salão é o controlador |
| Dado sensível de saúde (anamnese, ficha técnica) e fotos | LGPD art. 11 (fase 2) |
| Agenda e slots | receita do salão; integridade (dupla reserva) |
| Pagamentos (sinal Pix) | dinheiro do salão e do cliente |
| Credenciais: sessões, segredos, tokens de PSP e WhatsApp por salão | permitem agir em nome do salão |
| Isolamento entre tenants | confiança no produto |
| Cadeia de build (CI, dependências, `.claude/`) | comprometimento atinge todos os tenants |

## 3. Diagrama de fluxo de dados

```mermaid
flowchart LR
  subgraph internet["Internet (não confiável)"]
    X["Anônimo / bot"]
    C["Cliente final"]
    EQ["Equipe do salão"]
    PROV["Meta / PSP / e-mail"]
  end
  subgraph app["Vercel gru1"]
    PX["Proxy: nonce + CSP"]
    SA["Server Actions /<br/>Route Handlers"]
    WH["Webhooks<br/>(assinatura)"]
  end
  subgraph dados["Neon sa-east-1"]
    DB[("PostgreSQL<br/>RLS FORCE")]
    Q[("pgboss")]
  end
  subgraph wk["Fly gru"]
    W["Worker"]
  end
  subgraph cadeia["Cadeia de suprimentos"]
    CI["GitHub Actions / npm / IA"]
  end
  X & C & EQ -->|HTTPS| PX --> SA
  PROV -->|"HTTPS + HMAC/mTLS"| WH
  SA -->|"app_user + app.tenant_id"| DB
  WH -->|"grava evento bruto"| Q
  Q --> W
  W -->|"app_worker + tenant do job"| DB
  W -->|"safeFetch"| PROV
  CI -.->|"build e deploy"| app
  CI -.-> wk
```

## 4. STRIDE por componente

### 4.1 Página pública de agendamento (anônimo e cliente)

| STRIDE | Ameaça | Controle | Status |
|---|---|---|---|
| S | Reserva em nome de outra pessoa (telefone alheio) | OTP por WhatsApp antes de confirmar (configurável por salão); mensagem de confirmação ao número informado | [planejado] |
| T | Cliente manipula preço, duração, `tenantId`, `staffId` ou `status` no payload | Zod estrito; preço e duração recalculados no servidor a partir do catálogo; tenant resolvido pelo slug no servidor; FKs compostas | FKs [fundação]; o resto [planejado] |
| T | Cliente envia horário com offset ou fuso próprio | o servidor aceita só o horário escolhido entre os ofertados, recalcula o instante no fuso da unidade e revalida na transação | [planejado]; motor [fundação] |
| R | Cliente nega ter aceitado a política de cancelamento ou o sinal | aceite registrado com versão do texto, data e canal; `appointment_events` append-only | eventos [fundação]; aceite [planejado] |
| I | Enumeração de clientes pelo telefone ("já é cliente?") | nunca mostrar PII antes do OTP; resposta neutra; UNIQUE de telefone só por tenant | UNIQUE [fundação]; UI [planejado] |
| I | Link de "gerenciar meu agendamento" adivinhável (UUIDv7 é ordenável) | token aleatório de 32 bytes, guardado como hash, com expiração; trocado por cookie no primeiro acesso; `Referrer-Policy: no-referrer` nessa rota | [planejado] |
| D | Bot ocupa todos os horários de sábado (slot hoarding) | OTP + Turnstile; hold com TTL; limite de reservas pendentes por telefone e por tenant; sinal Pix opcional em horário de pico; rate limit por IP e por slug | [planejado] |
| D | SMS pumping no OTP (custo) | só `+55`; WhatsApp primeiro; Turnstile antes do envio; limites por número, IP, tenant, dia e global; orçamento diário por tenant; falha fechada sem Redis | [planejado] |
| E | Cliente acessa painel ou ação da equipe | sessão de cliente com papel próprio; matriz de autorização testada | [planejado] |

### 4.2 Painel do salão (equipe)

| STRIDE | Ameaça | Controle | Status |
|---|---|---|---|
| S | Credential stuffing ou phishing em conta do dono | MFA obrigatório (TOTP ou passkey); HIBP; rate limit por IP e por conta; passkeys incentivadas; cookies `__Host-` | [planejado] ([ADR-0004](../adr/0004-autenticacao-better-auth.md)) |
| T | Recepção altera preço ou status sem rastro | `appointment_events` grava cada transição com ator; trigger de máquina de estados no banco | [fundação] |
| T | Edição concorrente da agenda (arrastar e soltar) | lock otimista com `version` (trigger incrementa em todo UPDATE) | [fundação] |
| R | Funcionário nega cancelamento ou alteração | auditoria append-only (`UPDATE`, `DELETE` e `TRUNCATE` bloqueados até para o dono) | [fundação] |
| I | Profissional vê contatos ou anamnese de toda a base | DTO por papel (field-level); anamnese só para papéis autorizados, com step-up e auditoria de leitura | [planejado] |
| I | Funcionário exporta a base antes de sair | exportação só para o dono, com step-up, limite, alerta e auditoria; revogar sessões ao remover o membro | [planejado] |
| E | Profissional chama ação de dono | middleware de papel por action (`ownerAction`); matriz papel × ação com meta-teste "toda rota tem entrada" | [planejado] |
| E | Convite de organização aceito por outra pessoa | Better Auth ≥ 1.6.11 + `requireEmailVerificationOnInvitation` | [planejado] |

### 4.3 Servidor Next.js (Server Actions, Route Handlers, Proxy)

| STRIDE | Ameaça | Controle | Status |
|---|---|---|---|
| S | Bypass do Proxy (middleware) | o Proxy não autoriza nada; autorização dentro de cada action e handler; Next ≥ 16.3.8 | [fundação] (Proxy só com CSP) |
| T | XSS armazenado em nome do salão, serviço ou observação | escaping do React; CSP com nonce e `strict-dynamic`; `object-src 'none'`; `base-uri 'none'`; sem `dangerouslySetInnerHTML` (Biome) | [fundação] |
| T | CSRF em Route Handler | Server Actions: checagem nativa de `Origin` × `Host`; Route Handlers: `assertSameOrigin` (Fetch Metadata + `Origin` + `Content-Type: application/json`) | Actions nativo; handler [planejado] |
| T | Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` | [fundação] |
| I | Vazamento por erro (stack, SQL, `DETAIL` do banco) | páginas de erro só com `digest`; `@salon/db` traduz erros sem `DETAIL`; mensagem genérica no `handleServerError` | erros do banco e páginas [fundação] |
| I | Cache compartilhado entre tenants | sem `"use cache"` para dado de tenant; `cacheComponents` desligado; `no-store` em páginas autenticadas | [fundação] (desligado); `no-store` [planejado] |
| I | Endpoint de health revela versão ou dependências | `/api/health` responde só `{"status":"ok"}` com `no-store` | [fundação] |
| D | DoS por payload grande ou consulta cara | limite de corpo das actions; limites de intervalo no motor (366 dias, 2 anos); jobs assíncronos para exportação | motor [fundação]; o resto [planejado] |
| E | Server Action órfã ainda chamável | knip; inventário de actions no CI; toda action exportada com guarda (regra Semgrep `server-action-auth`) | Semgrep [fundação] |

### 4.4 PostgreSQL

| STRIDE | Ameaça | Controle | Status |
|---|---|---|---|
| S | Aplicação conecta com papel privilegiado (dono, superusuário, BYPASSRLS) | `app_user` e `app_worker` `NOSUPERUSER NOBYPASSRLS NOINHERIT`; invariantes no deploy recusam papel perigoso; papéis criados por SQL, não pelo console | [fundação] |
| T | Dupla reserva por corrida | `EXCLUDE USING gist (tenant_id =, staff_id =, during &&) WHERE (active)`; `active` derivada do status por trigger | [fundação] (corrida real testada) |
| T | Transição de status inválida (por exemplo, cancelado → confirmado) | trigger espelho da máquina de estados do core; teste de paridade; 81 pares testados no banco | [fundação] |
| T | Referência a cliente ou profissional de outro tenant | FKs compostas `(tenant_id, id)` | [fundação] |
| R | Alteração da auditoria | `appointment_events` escrita só por trigger `SECURITY DEFINER`; triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` | [fundação] |
| I | Leitura cross-tenant (IDOR/BOLA) | RLS `ENABLE` + `FORCE`, política RESTRICTIVE com `NULLIF(...)::uuid`; 0 linhas sem contexto | [fundação] |
| I | Canal encoberto por UNIQUE global | toda UNIQUE começa por `tenant_id` | [fundação] |
| I | View que roda como dono | invariante exige `security_invoker` | [fundação] |
| I | Troca de tenant por SQL injection (`set_config`) | SQL parametrizado (Drizzle); `sql.raw` só com constantes (regra Semgrep); DAL como primeira camada | [fundação] |
| D | Migração que trava tabela em produção | runner com `lock_timeout`, transação única e `pg_advisory_xact_lock`; revisão de migração | [fundação] |
| E | Função `SECURITY DEFINER` chamável pela aplicação | invariante recusa; `search_path` fixo | [fundação] |

### 4.5 Worker e jobs

| STRIDE | Ameaça | Controle | Status |
|---|---|---|---|
| T | Job processado no tenant errado | payload só com IDs + `tenantId`; `withTenant` por job; job sem tenant é rejeitado | papel [fundação]; worker [planejado] |
| R | Mensagem enviada duas vezes (custo, irritação) | `singletonKey` e `dedupe_key` únicas | [planejado] |
| I | PII no payload da fila ou no log do worker | payload mínimo; redaction no pino | [planejado] |
| D | Backlog da fila derruba o banco transacional | retenção de jobs concluídos; alerta de backlog e de DLQ | [planejado] |
| E | Worker com mais privilégio que o necessário | `app_worker` só lê e altera status | [fundação] |

### 4.6 Webhooks de entrada (Pix, WhatsApp)

| STRIDE | Ameaça | Controle | Status |
|---|---|---|---|
| S | Webhook forjado marca o sinal como pago | assinatura sobre o corpo cru com comparação em tempo constante (Mercado Pago: `x-signature` HMAC-SHA256; Meta: `X-Hub-Signature-256`); **reconsulta o pagamento na API do PSP** com o token do salão antes de mudar o estado | [planejado] |
| T | Replay de evento | deduplicação por `(provider, provider_event_id)`; janela de tempo quando o provedor envia `ts` | [planejado] |
| I | Payload sensível em log | log sem corpo; evento bruto acessível só ao worker | [planejado] |
| D | Flood de webhooks | resposta 2xx rápida e processamento em job; rate limit | [planejado] |

### 4.7 Integrações de saída

| STRIDE | Ameaça | Controle | Status |
|---|---|---|---|
| I | Token de WhatsApp ou PSP de um salão vaza | só no servidor e no worker; cifrado por tenant; escopo mínimo; rotação; secret scanning com regras para `APP_USR-` e `EAA…` | regras de scanning [fundação]; o resto [planejado] |
| I | SSRF para metadados da nuvem por URL configurável (ICS, webhook do salão, avatar) | `safeFetch`: só https, porta 443, sem credenciais na URL, sem redirect, resolução DNS validada (só IP público), timeout; proxy de egress no worker | [planejado] |
| T | Template de WhatsApp com conteúdo injetado | variáveis validadas e sem HTML; template utility sem conteúdo promocional | [planejado] |

### 4.8 CI/CD e cadeia de suprimentos

| STRIDE | Ameaça | Controle | Status |
|---|---|---|---|
| T | Dependência maliciosa (worm, conta sequestrada) | quarentena de 3 dias; `trustPolicy: no-downgrade`; scripts bloqueados (`strictDepBuilds`); `blockExoticSubdeps`; `pnpm audit signatures` | [fundação] |
| T | Action com tag movida | pin por SHA completo; zizmor; política de pinning nas configurações | [fundação] (pins); configuração [planejado] |
| T | Cache envenenado em job privilegiado | `cache-mode: none` em job com segredo; sem `pull_request_target` | [fundação] |
| I | Segredo commitado | gitleaks no pre-commit (se instalado) e no CI; push protection | CI [fundação] |
| E | PR de fork executa código com segredo | gatilho `pull_request`; forks excluídos dos jobs com segredo; aprovação para contribuidor externo | [fundação] |
| R | Commit forjado | commits assinados exigidos pelo ruleset | [planejado] (configuração do GitHub) |

### 4.9 Agente de IA (Claude Code)

| STRIDE | Ameaça | Controle | Status |
|---|---|---|---|
| T | Agente apaga dados ou faz push forçado | hook `guard-bash` (fail-closed): nega `rm -r` perigoso, `push --force`, push para `main`, `--no-verify`; pede confirmação para SQL destrutivo | [fundação] |
| I | Agente lê `.env`, chaves ou o ambiente | hooks `guard-bash` e `guard-files` negam leitura de segredo; `.env` real não existe na nuvem | [fundação] |
| T | Agente enfraquece teste ou lint para "passar" | regras no CLAUDE.md; revisão humana; skill `verify` antes de cada commit | [fundação] |
| T | Prompt injection por conteúdo do repositório ou de PR | conteúdo é dado, não instrução; ferramentas mínimas no CI; revisão consultiva | [fundação] |
| T | Persistência maliciosa em `.claude/` | CODEOWNERS; hooks negam escrita na configuração do agente; material de terceiros só vendorizado por SHA | [fundação] |

## 5. LINDDUN (privacidade), resumo

| Categoria | Ameaça no produto | Controle | Status |
|---|---|---|---|
| **L**inking | cruzar o mesmo telefone entre salões | identidade de cliente por tenant no MVP; UNIQUE só por tenant; métricas cross-tenant só agregadas | [fundação] (UNIQUE) |
| **I**dentifying | identificar o cliente em analytics ou logs | IDs opacos; `HMAC(segredo, telefone)` quando for preciso correlacionar; sem trackers de terceiros | [planejado] |
| **N**on-repudiation | registro excessivo de quem fez o quê (cliente) | auditoria com o mínimo: ator e transição, sem conteúdo | [fundação] |
| **D**etecting | inferir comportamento (frequência, horários) por terceiros | sem analytics de terceiros no app e na página pública; fontes e imagens só da própria origem | [fundação] (CSP `'self'`) |
| **D**ata disclosure | vazamento de anamnese, fotos ou telefone | RLS; criptografia de campo para sensível; redaction; Sentry sem PII | RLS [fundação]; o resto [planejado] |
| **U**nawareness | cliente não sabe do tratamento | aviso de privacidade do salão na página pública; texto da política versionado; opt-in de WhatsApp registrado | colunas [fundação]; UI [planejado] |
| **N**on-compliance | retenção indefinida, direito do titular sem atender | jobs de retenção; exportação e anonimização; DPA com o salão | CHECK de anonimização [fundação]; o resto [planejado] |

Detalhes em [../lgpd/README.md](../lgpd/README.md).

## 6. Casos de abuso do agendamento

Cada caso vira teste (integração, E2E ou carga) e entra na suíte de pentest
(skill `pentest-tenant`).

| # | Abuso | Resultado esperado | Onde testar | Status |
|---|---|---|---|---|
| A1 | 200 reservas simultâneas do mesmo horário e profissional | exatamente 1 sucesso; as demais recebem 409 com alternativas, nunca 5xx | integração (corrida real) + carga k6 | banco [fundação]; HTTP [planejado] |
| A2 | Reservas encostadas (10:00–10:30 e 10:30–11:00) | ambas aceitas (`[)`) | integração | [fundação] |
| A3 | Trocar `professionalId` ou `customerId` por um de outro tenant | FK composta falha ou 404; nada gravado | integração + E2E | banco [fundação] |
| A4 | Mesma `Idempotency-Key` com corpo diferente | 422; mesmo corpo devolve a resposta original | integração | UNIQUE [fundação]; HTTP [planejado] |
| A5 | Reativar agendamento expirado cujo horário já foi tomado (Pix tardio) | `23P01`, devolução automática do Pix e alternativas ao cliente | integração | revive [fundação]; devolução [planejado] |
| A6 | Cancelado → confirmado direto pela API | transição recusada (trigger e core) | unit + integração | [fundação] |
| A7 | Telefone novo a cada requisição a partir de um IP | bloqueio por IP e Turnstile | E2E + carga | [planejado] |
| A8 | Callback de pagamento repetido, sem assinatura ou com valor diferente | idempotente; 401; ignorado (vale a reconsulta ao PSP) | integração | [planejado] |
| A9 | Link de gerenciamento expirado ou de outro cliente | 404 genérico | E2E | [planejado] |
| A10 | Horário fora da jornada, antes da antecedência mínima ou além do horizonte | não ofertado; recusado na revalidação | propriedades P1 e P4 + integração | motor [fundação] |
| A11 | Cliente com relógio ou fuso do aparelho diferente | horários sempre no fuso da unidade, com offset visível quando o rótulo repetir | propriedades + E2E | motor [fundação] |
| A12 | Cancelamento "no prazo" forjado por relógio do cliente | prazo calculado no servidor com o `Clock` | unit | [planejado] |
| A13 | Hold infinito (pending sem expirar) | job expira holds vencidos a cada minuto; `CHECK` exige `hold_expires_at` em `pending` | integração | CHECK [fundação]; job [planejado] |
| A14 | Encaixe (overbook) feito por quem não pode | encaixe explícito, por papel autorizado e auditado | integração | [a decidir] |
| A15 | Scraping da base pelo autocomplete de clientes | limite de resultados e de taxa; só equipe autenticada | E2E | [planejado] |

## 7. Riscos aceitos e questões em aberto

| Item | Situação | Dono |
|---|---|---|
| `set_config` chamável por qualquer sessão (troca de tenant via SQLi) | aceito com SQL parametrizado + Semgrep + DAL. Assinatura HMAC do contexto (nível 3) fica para avaliação | mantenedor |
| MFA do cliente final (ASVS 6.3.3) | desvio aceito ([asvs-l2.md](asvs-l2.md#desvios-aceitos)) | mantenedor |
| Expiração de holds de todos os tenants (job sem tenant) | a decidir: loop por tenant ou função `SECURITY DEFINER` dedicada | threat model do worker |
| Resolução pública `slug → tenant` | função dedicada que devolve só o necessário | threat model da página pública |
| Encaixe (overbook) | o schema da fundação não tem bypass do `EXCLUDE`. Decidir se entra e como é auditado | produto + segurança |
