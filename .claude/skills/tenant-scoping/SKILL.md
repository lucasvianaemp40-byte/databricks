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
- **Teste negativo obrigatório.** Toda leitura/escrita nova ganha o caso "tenant B não vê nem
  altera dado do tenant A" (`packages/db/test/rls/` ou integração equivalente).
- **Logs e erros** sem PII de cliente nem segredo; erro de banco já sai sem `DETAIL`.
