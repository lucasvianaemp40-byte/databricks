---
paths:
  - "packages/db/drizzle/**"
  - "packages/db/src/schema/**"
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
- `timestamptz` para instantes, fuso IANA validado, dinheiro em centavos inteiros.
- Depois de gerar: `pnpm --filter @salon/db test`, `pnpm test:db` e a skill `review-migration`.
