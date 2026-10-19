---
name: steward
description: Convenções de commit, branch e Pull Request do Agenda Salão (Conventional Commits em pt-BR, escopos do monorepo, testes nunca enfraquecidos, migrações imutáveis, dependências com quarentena, descrição de PR). Use ao fazer commit, push ou abrir/atualizar PR.
---

# steward

## Commits
- Conventional Commits, assunto em pt-BR no imperativo, sem ponto final:
  `feat(core): adiciona cálculo de horários livres`.
- Tipos: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, `revert`.
- Escopos: `web`, `core`, `db`, `ci`, `claude`, `docs`, `deps`, `repo`, `security`.
- Um assunto por commit; corpo explica o PORQUÊ. Mudança incompatível: exclamação após o escopo
  (`feat(db)!: ...`) e rodapé `BREAKING CHANGE:`.
- Antes de cada commit, a skill `verify`. Nunca `--no-verify`, `LEFTHOOK=0` ou `-n`.

## Branches e push
- Trabalhe numa branch (`claude/<tema>` ou `<tipo>/<tema>`); nunca commite nem faça push direto
  para `main`/`master`; nunca `push --force` (use commit novo; `--force-with-lease` só com
  confirmação humana).

## Regras que não se negociam num PR
- **Testes nunca são enfraquecidos**: nada de apagar asserção, `.skip`/`.only`, trocar valor
  esperado sem prova, afrouxar lint/tsconfig, baixar limiar de cobertura.
- **Migração publicada é imutável**: correção é migração nova (forward-only).
- **Isolamento**: dado de tenant só via `withTenant`; tenant só da sessão; teste negativo
  cross-tenant para cada acesso novo.
- **Dependências**: pnpm com quarentena (`minimumReleaseAge`), versão exata, sem
  `dangerouslyAllowAllBuilds`; `pnpm-lock.yaml` só pelo pnpm.
- **Segredos** nunca no código, no chat ou em log; `.env.example` só com nomes e valores falsos.
- Decisão de arquitetura -> ADR em `docs/adr/`; mudança de comportamento -> docs atualizadas.

## Descrição do PR (pt-BR)
```
## O quê e por quê
## Como foi testado   (comandos + resultado; o que NÃO foi verificado e por quê)
## Riscos e rollback
## Segurança e LGPD   (achados tratados/aceitos; threat model, se houver)
## Migrações          (se houver: veredito do review-migration)
```
