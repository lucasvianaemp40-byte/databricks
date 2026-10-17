# Agenda Salão

> Nome provisório. Escopo npm: `@salon/*`.

SaaS multi-tenant de agendamento para **salões de beleza e barbearias no Brasil**. Cada salão
é um tenant isolado, cada unidade tem fuso IANA próprio, a interface é em pt-BR e o produto
segue a LGPD. A proposta: agenda por profissional e unidade, página pública de agendamento sem
app e sem senha, confirmação e lembrete por WhatsApp e sinal via Pix. Nada de fidelidade nem
de comissão sobre cliente do próprio salão (ver
[posicionamento](docs/produto/concorrentes-e-posicionamento.md)).

## Status: fundação (iteração 0)

| Pronto nesta iteração | Próximas iterações (documentado, não implementado) |
|---|---|
| Monorepo pnpm 11 + Turborepo, TypeScript 6 estrito, Biome + ESLint enxuto | Autenticação e organizações (Better Auth: 2FA, passkeys) |
| `@salon/scheduling-core`: motor de disponibilidade puro (Temporal, `Clock` injetado) com testes de exemplo e de propriedade | Cadastro do salão, agenda da recepção, página pública de agendamento |
| `@salon/db`: schema PostgreSQL com RLS `ENABLE` + `FORCE`, FKs compostas, `EXCLUDE` anti-overbooking, máquina de estados e auditoria no banco | Worker com pg-boss: lembretes, expiração de holds, retenção |
| `@salon/web`: esqueleto Next.js 16 com CSP por nonce, cabeçalhos de segurança, env validada, E2E com axe | WhatsApp Cloud API, Pix (Mercado Pago), Sentry, rate limit |
| CI com gates de qualidade e segurança, pins por SHA/digest, Renovate | Deploy (Vercel `gru1`, Neon `sa-east-1`, Fly `gru`) |
| Kit Claude Code (hooks fail-closed, skills, agentes) e esta documentação | |

Roteiro completo em [docs/produto/mvp-e-roadmap.md](docs/produto/mvp-e-roadmap.md).

## Stack

Versões exatas do catálogo em [`pnpm-workspace.yaml`](pnpm-workspace.yaml). As escolhas e as
alternativas descartadas estão nos [ADRs](docs/adr/README.md).

| Camada | Escolha |
|---|---|
| Runtime | Node.js 24 em CI e produção (`.nvmrc`); desenvolvimento aceita `>=22.22.0` |
| Gerenciador e monorepo | pnpm 11.28.5 (via Corepack, com hash) + Turborepo 2.11 |
| Linguagem | TypeScript 6.0.3 (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) |
| Web | Next.js 16.4 (App Router, `src/proxy.ts`), React 19.3, Tailwind CSS 4.3, Zod 4 |
| Domínio | `temporal-polyfill` 1.0.6 (Temporal), sem I/O |
| Dados | PostgreSQL (CI 18.6, local 16), Drizzle ORM 0.45.4 + drizzle-kit 0.31.11, `pg` 8.23 |
| Testes | Vitest 5, fast-check 4 (+ `@fast-check/vitest`), Playwright 1.64 + `@axe-core/playwright` |
| Lint e formatação | Biome 2.5 (formatação e lint geral) + ESLint 10 (type-aware, segurança, regras de domínio) |

## Começando

Pré-requisitos: Node.js 24 (ou 22.22+) e Git. O PostgreSQL de teste é opcional, porque
`pnpm test:db` sobe um cluster efêmero se encontrar os binários locais.

```bash
corepack enable          # usa o pnpm declarado em package.json (packageManager, com hash)
pnpm install --frozen-lockfile
pnpm hooks:install       # opcional: hooks Git do lefthook (o postinstall é bloqueado de propósito)
pnpm verify              # gate local: formato, lint, tipos, testes e build
pnpm dev                 # app web em http://localhost:3000
```

Variáveis de ambiente: cada pacote documenta as suas no próprio `.env.example`
([raiz](.env.example), [web](apps/web/.env.example), [db](packages/db/.env.example)). Nunca
versione `.env` com valores reais.

### Comandos do repositório

| Comando | O que faz |
|---|---|
| `pnpm build` · `pnpm dev` · `pnpm typecheck` | build, servidor de desenvolvimento e checagem de tipos (via Turborepo) |
| `pnpm test` | testes unitários e de propriedade, sem banco |
| `pnpm test:db` | integração e RLS num PostgreSQL real. Usa `TEST_DATABASE_URL`; sem ela, [`scripts/with-local-postgres.sh`](scripts/with-local-postgres.sh) sobe um PostgreSQL efêmero com os binários de `/usr/lib/postgresql/*/bin` |
| `pnpm e2e` | Playwright contra o build de produção do app web |
| `pnpm lint` · `pnpm lint:fix` | `biome check` + ESLint |
| `pnpm format` · `pnpm format:check` | formatação com Biome |
| `pnpm test:hooks` | testes dos hooks do Claude Code (`node --test .claude/hooks/test`) |
| `pnpm verify` | `format:check` + `lint` + `typecheck` + `test` + `build` (o gate local; `test:db` e `e2e` são separados) |
| `pnpm knip` | código e dependências sem uso |

Ciclo rápido num pacote: `pnpm --filter @salon/scheduling-core test`. Detalhes em
[docs/qa/estrategia.md](docs/qa/estrategia.md).

## Estrutura do monorepo

```
apps/
  web/                    @salon/web: Next.js 16 (página pública, painel, Server Actions, Proxy com CSP)
packages/
  scheduling-core/        @salon/scheduling-core: domínio puro (disponibilidade, tempo, máquina de estados)
  db/                     @salon/db: schema Drizzle, migrações, RLS, withTenant, runner de migração
docs/                     arquitetura, ADRs, segurança, LGPD, domínio, produto, QA, desenvolvimento
scripts/                  with-local-postgres.sh, vendor-claude-skills.sh
.claude/                  kit do Claude Code: hooks, skills, agentes, regras
.github/                  CI, segurança, DAST, revisão por IA, CODEOWNERS, ruleset
```

Os pacotes internos exportam o fonte TypeScript, sem build próprio. O Next.js os transpila via
`transpilePackages`. O domínio não importa banco, framework nem relógio global, e o lint
garante isso. Leia o README do pacote antes de mexer nele:
[web](apps/web/README.md), [scheduling-core](packages/scheduling-core/README.md) e
[db](packages/db/README.md).

## Documentação

Índice completo em [docs/README.md](docs/README.md). Pontos de entrada:

- [Arquitetura](docs/arquitetura.md): contexto, contêineres, fronteiras de confiança, multi-tenancy, tempo, jobs e hospedagem
- [Decisões (ADRs)](docs/adr/README.md)
- [Segurança](docs/seguranca/README.md): modelo de ameaças, ASVS 5.0 nível 2, cabeçalhos, incidentes, supply chain
- [LGPD](docs/lgpd/README.md): papéis, inventário de dados, direitos do titular, retenção
- [Domínio](docs/dominio/modelo.md) e [glossário](docs/dominio/glossario.md)
- [Produto](docs/produto/mvp-e-roadmap.md) e [backlog](docs/produto/backlog-inicial.md)
- [QA](docs/qa/estrategia.md) e [critérios de aceite](docs/qa/criterios-de-aceite.md)
- [Fluxo com o Claude Code](docs/desenvolvimento/fluxo-com-claude.md)

## Como contribuir

1. Crie uma branch a partir de `main`. Push direto para `main` é bloqueado pelo ruleset.
2. Use TDD: o teste falha primeiro, depois vem o código. Nenhum teste é enfraquecido para
   passar (ver [CLAUDE.md](CLAUDE.md), seção "Regras inegociáveis").
3. Escreva commits no formato [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/),
   com assunto em pt-BR no imperativo, por exemplo `feat(core): adiciona cálculo de horários
   livres`. O commitlint valida a mensagem e os commits precisam ser assinados.
4. Antes do PR, rode `pnpm verify` e também `pnpm test:db` ou `pnpm e2e` quando a mudança
   tocar banco ou UI. Preencha o [template de PR](.github/pull_request_template.md).
5. Para uma decisão de arquitetura nova, escreva um ADR a partir do [modelo](docs/adr/0000-modelo.md).
6. Dependência nova precisa de justificativa e versão exata, e passa pela quarentena de 3
   dias ([política](docs/seguranca/supply-chain.md)).

Os checks obrigatórios do merge são `ci-ok` e `security-ok`. A configuração do GitHub que não
fica em arquivo está em [.github/rulesets/README.md](.github/rulesets/README.md).

**Vulnerabilidades:** não abra issue pública. Siga o [SECURITY.md](SECURITY.md).

## Sobre este repositório

- `list_refat_jobs.py` é um **utilitário legado de Databricks** que lista jobs com sufixo
  `_refat` pela API REST de Jobs. Não tem relação com o produto, foi preservado como estava e
  não participa do build, do lint nem dos testes do monorepo.
- **Recomendação: mover o produto para um repositório dedicado.** O nome `databricks` não
  descreve o projeto e mistura dois contextos de segurança (credenciais e histórico de
  Databricks com dados de salões). Um repositório próprio também simplifica CODEOWNERS,
  ruleset, secret scanning e o histórico de auditoria. Ao migrar, preserve o histórico com
  `git filter-repo` ou recomece a partir da fundação.

## Licença

Proprietário (`UNLICENSED`): todos os direitos reservados. Os materiais de terceiros incluídos
em `.claude/` têm licenças próprias, listadas em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
