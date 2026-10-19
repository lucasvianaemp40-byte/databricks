---
name: tenant-scoping
description: Regras obrigatórias de isolamento multi-tenant ao escrever ou alterar acesso a dados, Server Actions, Route Handlers, jobs, schema e políticas RLS do Agenda Salão. Vale para qualquer código que leia ou grave dados de salão, unidade, profissional, cliente, serviço, agendamento ou pagamento.
user-invocable: false
paths:
  - "packages/db/**"
  - "apps/web/src/server/**"
  - "apps/web/src/app/**/actions.ts"
  - "apps/web/src/app/**/route.ts"
---

# Isolamento multi-tenant (conhecimento de fundo)

- **Tenant só da sessão.** O `tenantId` vem da sessão autenticada no servidor (membership
  verificada), nunca de body, query string, parâmetro de rota, header, cookie não assinado ou
  subdomínio sem checagem de vínculo.
- **Uma porta só.** Todo dado de tenant passa por `withTenant(db, tenantId, fn, { actor })` de
  `@salon/db`. Nada de `db.select()` fora dele em código de requisição, nada de
  `set_config('app.tenant_id', ...)` à mão, nada de `sql.raw` com entrada do usuário.
- **O `tx` só vale durante `fn`.** Aguarde toda consulta dentro do callback: nada de `after()`,
  `setTimeout`, fire-and-forget ou builder devolvido para executar depois. Ramos paralelos que
  podem falhar vão em `Promise.allSettled` (ou são aguardados um a um), nunca em `Promise.all`
  fail-fast: o ramo pendente continuaria depois do fim da transação. O uso tardio é recusado
  com `TransactionClosedError`, que é bug do chamador (500 e correção, sem retentativa).
- **Ids do servidor.** A PK `id` é global (não começa por `tenant_id`): nunca aceite `id` nem
  `tenant_id` do cliente em INSERT/upsert e nunca faça UPDATE de `id`; use `newId()` ou o
  default da coluna. `IdentifierConflictError` vira resposta genérica (404 ou 409 sem
  detalhe), nunca "já existe": seria um oráculo de existência entre tenants.
- **Papel certo.** A aplicação conecta como `app_user` (web) ou `app_worker` (jobs): NOBYPASSRLS
  e sem ser dono. URL de `app_migrator`/superusuário só no runner de migração.
- **Validação.** zod em toda entrada (Action, Route Handler, webhook, job). Schema estrito
  (`.strict()`): rejeite `tenantId`, `role`, `price`, `status`, `staffId` que o usuário não
  pode escolher (mass assignment).
- **Autorização no servidor, por ação.** Cliente, profissional, gerente e dono têm permissões
  diferentes; cheque o papel dentro de cada Action/Route Handler. O Proxy do Next não autoriza.
- **Não revele existência.** Recurso de outro tenant responde 404 (o banco devolve 0 linhas ou
  `TenantIsolationError`); UNIQUEs começam por `tenant_id` para não vazar entre salões.
- **Tabela nova de tenant:** `tenantIdColumn()`, FKs compostas `(tenant_id, id)`, UNIQUE com
  `tenant_id` primeiro e migração custom com ENABLE + FORCE RLS, `tenant_isolation`
  RESTRICTIVE, `app_access` PERMISSIVE e GRANTs mínimos (checklist em `packages/db/README.md`).
- **Tempo.** `timestamptz` em UTC no banco; fuso IANA da unidade só na borda (UI, notificação).
  O banco aceita só nomes `Area/Local` sem dígito: para UTC explícito use `'Etc/UTC'`, não
  `'UTC'`.
- **Teste negativo obrigatório.** Toda leitura/escrita nova ganha o caso "tenant B não vê nem
  altera dado do tenant A" (`packages/db/test/rls/` ou integração equivalente).
- **Logs e erros** sem PII de cliente nem segredo. Os erros traduzidos já saem sem `DETAIL`,
  mas o `DrizzleQueryError` cru (e o `cause` dos traduzidos) traz os parâmetros da consulta na
  mensagem: nunca o registre inteiro; registre só `code`, `sqlState` e `constraint`.
