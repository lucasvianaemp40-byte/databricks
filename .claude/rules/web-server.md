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
- Código só de servidor fica em `src/server/` e importa `server-only` (adicione o pacote junto
  com o primeiro módulo). Nada com prefixo `NEXT_PUBLIC_` é segredo; variável nova entra em
  `src/env.ts`, no `turbo.json` do pacote e no `.env.example`.
- Sem `dangerouslySetInnerHTML` e sem atributo `style` inline (a CSP de produção bloqueia).
