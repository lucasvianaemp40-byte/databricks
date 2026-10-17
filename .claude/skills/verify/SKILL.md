---
name: verify
description: Portão de qualidade do Agenda Salão. Roda pnpm verify (formato, lint, typecheck, testes, build) e, conforme o que mudou, pnpm test:db, pnpm test:hooks e pnpm e2e, e resume o que passou e o que não foi verificado. Use antes de CADA commit e sempre que pedirem para verificar uma mudança.
allowed-tools:
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(pnpm verify)
  - Bash(pnpm test:db)
  - Bash(pnpm test:hooks)
  - Bash(pnpm exec tsc -p .claude/hooks)
  - Bash(pnpm e2e)
---

# verify

Rode em ordem e PARE no primeiro passo vermelho: corrija a causa e recomece do passo 2.

1. Entenda o escopo: `git status --porcelain` e `git diff --stat HEAD`.
2. `pnpm verify` (format:check, lint, typecheck, test, build). Obrigatório para qualquer
   mudança em código, configuração ou dependência. Mudança só em `docs/**/*.md` ou `*.md`:
   basta `pnpm format:check` e `pnpm lint`.
3. Mudou `packages/db/**` (schema, migração, `withTenant`, queries) ou regra de isolamento:
   `pnpm test:db` (PostgreSQL real; sobe um efêmero se não houver `TEST_DATABASE_URL`).
   Migração nova ou schema alterado: use também a skill `review-migration` e só siga com
   veredito APROVAR.
4. Mudou `.claude/hooks/**`: `pnpm test:hooks` e `pnpm exec tsc -p .claude/hooks`.
5. Mudou UI, rota, Server Action ou fluxo de reserva em `apps/web`: `pnpm e2e`. Sem navegador
   disponível, diga isso explicitamente em vez de declarar verificado.
6. Cobertura do comportamento: se a mudança tocou regra de agenda, disponibilidade, preço,
   cancelamento, autorização ou dado de tenant, confirme que existe teste novo cobrindo-a,
   inclusive o negativo cross-tenant (tenant B não vê nem altera dado do tenant A). Se não
   existir, escreva-o antes do commit.
7. Segredos: se `gitleaks` estiver instalado, `gitleaks git --staged --redact --no-banner`;
   senão, registre que a varredura fica para o CI.

## Proibido
- `--no-verify`, `LEFTHOOK=0`, `.skip`/`.only`, apagar ou afrouxar asserção, aumentar timeout
  ou desligar regra de lint para "passar". Se um teste está errado, prove antes de mudá-lo.
- Declarar "verificado" algo que não foi executado.

## Resumo final (sempre)
Tabela com cada comando, resultado (passou/falhou/não executado) e o motivo do que não foi
executado (ex.: sem Chromium, sem PostgreSQL local).
