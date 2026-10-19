# Inventário de dados pessoais

Inventário por tabela do schema `app` da fundação
([`packages/db/drizzle/0002_schema.sql`](../../packages/db/drizzle/0002_schema.sql)), mais o que
está planejado. Serve de base para o registro das operações (art. 37), a exportação, a
anonimização e a retenção. **Atualize no mesmo PR que criar ou mudar uma coluna.** Bases legais
e retenção são propostas **a validar com jurídico**
([papéis e bases](papeis-e-bases-legais.md), [retenção](retencao.md)).

**Proteções comuns a todas as tabelas de tenant (implementadas):**

- RLS `ENABLE` + `FORCE` por tenant;
- FKs compostas;
- acesso só pelo papel `app_user` ou `app_worker`;
- instantes em UTC.

**Proteções planejadas:** TLS `verify-full`, criptografia em repouso do provedor e backups
cifrados.

Legenda da coluna "Pessoal?": **Sim**; **Indireto** (identifica pessoa quando combinado com
outra tabela); **Talvez** (depende do que o salão digita: texto livre ou nome de MEI); **Não**.

## Tabelas da fundação

### `tenants` (salão)

| Coluna | Pessoal? | Categoria | Observação |
|---|---|---|---|
| `id`, `status`, timestamps | Não | — | |
| `name` | Talvez | identificação do salão | salão MEI costuma usar o nome do dono ("Barbearia do Fulano") |
| `slug` | Talvez | identificador público | aparece na URL pública. Não permitir CPF ou telefone no slug |

Titular: dono (quando MEI). Controlador: plataforma (cadastro do cliente do SaaS). Base: art.
7º, V. Retenção: enquanto houver contrato, e depois o prazo de encerramento.

### `locations` (unidade)

| Coluna | Pessoal? | Categoria | Observação |
|---|---|---|---|
| `name`, `slug`, `timezone`, regras de agenda | Não | — | |
| `phone_e164` | Talvez | contato | em MEI costuma ser o celular pessoal do dono. Exibido na página pública por decisão do salão |

### `staff` (profissional)

| Coluna | Pessoal? | Categoria | Finalidade | Observação |
|---|---|---|---|---|
| `display_name` | Sim | identificação | exibir na agenda e na página pública | o profissional escolhe o nome exibido |
| `phone_e164` | Sim | contato | contato interno | não exibir na página pública |
| `engagement_type` (`owner`, `employee`, `partner`, `freelancer`) | Sim | relação de trabalho | comissão ou cota-parte (Lei do Salão-Parceiro) | confidencial: visível só ao dono e à gerência |
| `default_commission_bps` | Sim | remuneração | cálculo de comissão | confidencial |
| `bookable_online`, `active` | Indireto | — | operação | |

Titular: profissional. Controlador: salão. Base: art. 7º, V (contrato de trabalho ou parceria).

### `staff_services`

| Coluna | Pessoal? | Observação |
|---|---|---|
| `price_cents`, `duration_min` | Não | |
| `commission_bps` (por profissional) | Sim (remuneração) | confidencial |

### `services`

Sem dado pessoal. Atenção: o **nome do serviço** é escolhido pelo salão e copiado para
`appointment_items.service_name`. Um nome que revele condição de saúde (por exemplo, um
procedimento para paciente em tratamento) transforma o histórico de agendamentos em dado
sensível. A UI deve orientar o salão a usar nomes neutros.

### `working_hours` e `time_off`

| Tabela | Coluna | Pessoal? | Observação |
|---|---|---|---|
| `working_hours` | jornada semanal do profissional | Sim (jornada de trabalho) | visível à equipe do salão |
| `time_off` | `kind` (`time_off`, `vacation`, `training`, `blocked`), `starts_at`, `ends_at` | Sim | ausências do profissional |
| `time_off` | `note` (texto livre, até 200 caracteres) | **Talvez sensível** | **risco:** "consulta médica" ou "atestado" é dado de saúde do profissional. A UI deve desencorajar o motivo detalhado: o `kind` basta. A exportação e a anonimização incluem o campo |

### `customers` (cliente final)

| Coluna | Pessoal? | Categoria | Finalidade | Base sugerida |
|---|---|---|---|---|
| `full_name` | Sim | identificação | atendimento | art. 7º, V |
| `phone_e164` (único por tenant) | Sim | contato | confirmação, lembrete e identificação prática (WhatsApp) | art. 7º, V |
| `email` (opcional) | Sim | contato | comprovantes | art. 7º, V |
| `whatsapp_opt_in_at` | Sim | consentimento | prova do opt-in exigido pela Meta para templates | registro de conformidade |
| `marketing_consent_at` | Sim | consentimento | prova do consentimento de marketing | art. 7º, I |
| `privacy_notice_version` | Indireto | transparência | qual versão do aviso o cliente viu | registro de conformidade |
| `anonymized_at` | Indireto | ciclo de vida | marca a anonimização (direito de eliminação) | — |

Titular: cliente final. Controlador: salão. Operador: plataforma. Proteção extra
implementada: o CHECK `customers_anonymized_without_contact` impede uma linha anonimizada de
manter telefone, e-mail ou consentimentos.

### `appointments` (agendamento)

| Coluna | Pessoal? | Observação |
|---|---|---|
| `customer_id`, `location_id` | Indireto | liga o agendamento ao cliente |
| `starts_at`, `ends_at`, `local_starts_at`, `timezone` | Indireto | histórico de frequência e hábitos |
| `status`, `source`, instantes de cada transição (`confirmed_at`, `cancelled_at`, `no_show_at`…) | Indireto | inclui no-show, que é informação comportamental. Usar só para a operação do salão |
| `cancellation_reason` (texto livre, até 500) | **Talvez sensível** | **risco** de conter motivo de saúde ou dado de terceiro. Orientar na UI; incluir na exportação e na anonimização |
| `hold_expires_at`, `idempotency_key`, `rescheduled_from_id`, `version` | Não | técnicos |

### `appointment_items`

| Coluna | Pessoal? | Observação |
|---|---|---|
| `service_name`, `duration_min`, `starts_at`, `ends_at` | Indireto | o que o cliente fez (ver a nota sobre nome de serviço) |
| `staff_id` | Indireto | quem atendeu |
| `price_cents`, `commission_bps` | Sim (remuneração do profissional; gasto do cliente) | snapshot para comissão e relatório |

### `occupancies`

Ocupação da agenda do profissional (`staff_id`, `starts_at`, `ends_at`, `kind` de serviço ou
buffer, `active`). É dado pessoal indireto do profissional (jornada efetiva). Não contém dado do
cliente além do vínculo com o agendamento.

### `appointment_events` (auditoria)

| Coluna | Pessoal? | Observação |
|---|---|---|
| `actor_type` (`customer`, `staff`, `system`, `unknown`), `actor_id` | Sim (quem fez) | prova de quem confirmou, cancelou ou marcou no-show |
| `event_type`, `from_status`, `to_status`, `created_at` | Indireto | trilha de transições |

**Append-only:** `UPDATE`, `DELETE` e `TRUNCATE` são bloqueados até para o dono. Isso conflita
com a eliminação. Como a tabela guarda só IDs e transições, a anonimização do cliente (em
`customers`) basta para desvincular a pessoa. A eliminação total de um tenant exige um
procedimento privilegiado dedicado, ainda pendente (ver [retenção](retencao.md)).

## Planejado (próximas iterações)

| Armazenamento | Dados pessoais | Controlador | Observação |
|---|---|---|---|
| Schema `auth` (Better Auth): `user`, `session`, `account`, `verification`, `twoFactor`, `passkey`, `organization`, `member`, `invitation`, `rateLimit` | e-mail, nome, hash de senha, segredo TOTP cifrado, chaves públicas de passkey, IP e user agent das sessões, OTP temporário | Plataforma | papel `app_auth`; tokens de verificação com hash |
| Consentimentos (append-only) | finalidade, concedido ou revogado, versão do texto, canal, evidência | Salão | `whatsapp_transactional`, `whatsapp_marketing`, `email_marketing`, `health_data`, `image_use` |
| Ficha técnica e anamnese | **dado de saúde** | Salão | criptografia de campo; ver [dados sensíveis](dados-sensiveis.md) |
| Fotos de antes e depois | imagem | Salão | bucket privado; consentimento específico para portfólio |
| Pagamentos (Pix) | valor, txid, nome do pagador, Pix copia e cola | Salão (PSP em parte) | sem dado de cartão |
| Notificações (WhatsApp, e-mail) | destinatário, template, status de entrega | Salão | conteúdo do template não guardado além do necessário |
| Eventos de webhook recebidos | payload do provedor (pode ter telefone e nome) | Plataforma/Salão | só o worker acessa; retenção curta |
| Chaves de idempotência | hash da requisição; corpo da resposta | Salão | TTL de 24 h |
| Auditoria de acesso a dado sensível | quem leu qual ficha, quando e por quê | Salão | append-only |
| Lista de espera | cliente, serviço, janela de datas | Salão | |

## Fora do banco

| Onde | Dados | Regra |
|---|---|---|
| Logs da aplicação (pino, Vercel) | IDs opacos, `requestId`; IP só em registro de acesso | redaction de telefone, e-mail, OTP, tokens e cookies (regra Semgrep `pii-in-logs`); nunca o erro cru do banco (`DrizzleQueryError` e `cause` trazem os parâmetros da consulta); IP por 6 meses ([ADR-0010](../adr/0010-observabilidade.md), proposto) |
| Sentry | erros | `sendDefaultPii: false`, `beforeSend` com redaction, túnel na mesma origem, região UE se possível ([ADR-0010](../adr/0010-observabilidade.md)) |
| Upstash Redis | chaves de rate limit | usar `HMAC(segredo, telefone)` em vez do telefone, com TTL curto |
| pg-boss | payload de job | só IDs + `tenantId` |
| Meta (WhatsApp) | telefone, conteúdo do template | suboperador fora do Brasil (cláusulas-padrão) |
| Provedor de e-mail | e-mail, conteúdo | suboperador |
| Backups e PITR do PostgreSQL | tudo | cifrados; tombstones reaplicados depois de restaurar ([direitos do titular](direitos-do-titular.md)) |
| Repositório, testes, seeds, prompts de IA | **nenhum dado real** | gitleaks com regras de CPF e CNPJ; dados sintéticos |
