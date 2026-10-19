---
paths:
  - "apps/web/src/server/**"
  - "apps/web/src/app/**/actions.ts"
  - "apps/web/src/app/**/route.ts"
  - "apps/web/src/proxy.ts"
---

# Servidor web (Server Actions, Route Handlers, Proxy)

- O tenant vem da SESSÃO (membership verificada), nunca de input (body, query, params, header,
  cookie não assinado, subdomínio sem checagem).
- zod em TODA entrada, com schema estrito (sem mass assignment de `tenantId`, `role`, `price`,
  `status`). Erro de validação devolve mensagem genérica, sem eco de dado pessoal.
- Autenticação e autorização dentro de CADA Action/Route Handler. O Proxy (`proxy.ts`) só cuida
  de nonce/CSP: ele NÃO autoriza nada.
- Dado de tenant só via `withTenant(db, session.tenantId, fn, { actor })`; recurso de outro
  tenant responde 404.
- O `tx` só vale enquanto `fn` executa: aguarde toda consulta dentro do callback. Nada de
  `after()`, `setTimeout`, fire-and-forget ou builder devolvido para rodar depois; com ramos
  paralelos que podem falhar, use `Promise.allSettled` (ou aguarde cada um), nunca
  `Promise.all` fail-fast (o ramo pendente roda depois do fim da transação).
- Ids nascem no servidor (`newId()`/default da PK): nunca aceite `id` nem `tenant_id` do
  cliente em INSERT/upsert e nunca faça UPDATE de `id`.
- Erros de `@salon/db`: `TenantIsolationError` -> 404; `IdentifierConflictError` -> 404/409
  genérico, nunca "já existe" (a PK é global: seria oráculo de existência entre tenants);
  `TransactionClosedError` -> 500 e correção do chamador (é bug, não entrada inválida).
- Nunca registre em log o `DrizzleQueryError` cru nem o `cause` dos erros traduzidos: a
  mensagem traz os parâmetros da consulta (dado pessoal). Registre só `code`, `sqlState` e
  `constraint`.
- Fuso é sempre o IANA da unidade; para UTC explícito use `'Etc/UTC'` (o banco recusa `'UTC'`).
- Código só de servidor fica em `src/server/` e importa `server-only` (adicione o pacote junto
  com o primeiro módulo). Nada com prefixo `NEXT_PUBLIC_` é segredo; variável nova entra em
  `src/env.ts`, no `turbo.json` do pacote e no `.env.example`.
- Sem `dangerouslySetInnerHTML` e sem atributo `style` inline (a CSP de produção bloqueia).
