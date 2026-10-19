---
paths:
  - "packages/db/drizzle/**"
  - "packages/db/src/**"
  - "packages/db/test/**"
  - "packages/db/**/migrations/**"
---

# Banco e migrações (@salon/db)

- Migração commitada é IMUTÁVEL (o runner recusa arquivo alterado e o hook nega a edição).
  Corrija com migração nova, forward-only.
- Gere com `pnpm --filter @salon/db generate --name=<descricao>` (schema) ou
  `generate:custom <nome>` (RLS, GRANT, trigger, EXCLUDE). Nunca `drizzle-kit push/migrate`
  nem edição manual de `drizzle/meta/*`.
- O runner aplica tudo numa transação única com `lock_timeout`: nada de `CONCURRENTLY`.
- Tabela de tenant: `tenantIdColumn()`, FKs compostas `(tenant_id, id)`, UNIQUE começando por
  `tenant_id`, ENABLE + FORCE RLS, `tenant_isolation` RESTRICTIVE, `app_access` PERMISSIVE,
  GRANTs mínimos para `app_user`/`app_worker`, trigger de `updated_at`.
- `timestamptz` para instantes, fuso IANA validado (`Area/Local` sem dígito: `'Etc/UTC'`,
  nunca `'UTC'` nem `Etc/GMT+3`), dinheiro em centavos inteiros.
- Depois de gerar: `pnpm --filter @salon/db test`, `pnpm test:db` e a skill `review-migration`.

## Acesso a dados (`withTenant`)

- O `tx` só vale enquanto `fn` executa: nada de `after()`, `setTimeout`, fire-and-forget ou
  builder devolvido; ramos paralelos que podem falhar vão em `Promise.allSettled`, não em
  `Promise.all` fail-fast. Uso tardio do `tx` é recusado com `TransactionClosedError` (bug do
  chamador: 500 e correção, nunca retentativa).
- A PK `id` é global: id vem do servidor (`newId()`/default), nunca do cliente em
  INSERT/upsert, e `id` nunca é atualizado. `IdentifierConflictError` vira resposta genérica
  (404/409), nunca "já existe".
- `DrizzleQueryError` e o `cause` dos erros traduzidos carregam os parâmetros da consulta
  (PII): não registre crus; use `code`/`sqlState`/`constraint`.
