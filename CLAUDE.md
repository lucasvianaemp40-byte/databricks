# Agenda Salão

SaaS multi-tenant de agendamento para salões de beleza e barbearias no Brasil: agenda por
profissional e unidade, página pública de reserva, confirmações e lembretes, Pix. Cada salão é
um tenant isolado; cada unidade tem fuso IANA próprio. Produto em pt-BR, sujeito à LGPD.

Documentação (índice, arquitetura, ADRs, segurança, LGPD, domínio, produto, QA): @docs/README.md

## Mapa do monorepo

| Caminho | Pacote | Papel |
| --- | --- | --- |
| `apps/web` | `@salon/web` | Next.js 16 (App Router), UI, Server Actions, Route Handlers, Proxy (CSP) |
| `packages/scheduling-core` | `@salon/scheduling-core` | domínio PURO: disponibilidade, tempo (Temporal), máquina de estados |
| `packages/db` | `@salon/db` | Drizzle + PostgreSQL, RLS, `withTenant`, migrações e runner próprio |
| `.claude/` | — | hooks, skills, agentes e regras do Claude Code (ver `.claude/README.md`) |
| `scripts/` | — | `with-local-postgres.sh`, `vendor-claude-skills.sh` |

Leia o README do pacote antes de mexer nele: `packages/db/README.md` (modelo de segurança),
`packages/scheduling-core/README.md` (regras de tempo), `apps/web/README.md` (CSP, env).

## Comandos (contrato do repositório)

| Comando | Quando |
| --- | --- |
| `pnpm verify` | antes de todo commit: format:check, lint, typecheck, test, build e knip |
| `pnpm test` | testes dos pacotes (turbo) e `pnpm test:root` (`eslint.base.test.mjs`, `biome-plugins/` e `scripts/`); `test:root` e `test:hooks` reprovam teste pulado ou pendente (`scripts/no-disabled-tests-reporter.mjs`) |
| `pnpm test:db` | mudou `packages/db` ou isolamento: PostgreSQL real. Usa `TEST_DATABASE_URL`; sem ela, sobe um cluster efêmero com os binários locais (PG 16+); sem binários, `docker compose up -d --wait postgres-test` e exporte a URL do `compose.yaml` |
| `pnpm e2e` | mudou UI/fluxo: Playwright contra o build de produção (porta 3100) |
| `pnpm test:hooks` | mudou `.claude/hooks/` ou `.claude/settings.json` (e `pnpm exec tsc -p .claude/hooks`) |
| `pnpm --filter <pacote> <script>` | ciclo rápido num pacote (`test`, `typecheck`, `lint`) |
| `pnpm --filter @salon/db generate` / `generate:custom <nome>` | gerar migração (nunca `drizzle-kit push/migrate`) |
| `pnpm knip` | código e dependências sem uso (já roda no `verify` e no job `static` do CI); sozinho, para o ciclo rápido |

Node 22.22+ e pnpm 11 (via corepack). Nunca use npm, yarn ou npx para instalar ou rodar
pacotes: use `pnpm --filter <pacote> exec <bin>`.

## Regras inegociáveis

1. **Isolamento entre tenants.** O `tenantId` vem SÓ da sessão no servidor. Todo dado de
   tenant passa por `withTenant(db, tenantId, fn, { actor })`; a RLS (ENABLE + FORCE) é a
   segunda camada, não a única. Recurso de outro tenant responde 404. Toda leitura/escrita
   nova ganha o teste negativo "tenant B não vê nem altera dado do tenant A".
2. **Tempo e fuso.** Instantes em UTC (`timestamptz`, `Temporal.Instant`); fuso IANA da
   UNIDADE, nunca o da máquina nem offset fixo. No `@salon/scheduling-core`, "agora" só pelo
   `Clock` injetado (o lint proíbe `Date.now`, `new Date()`, `Temporal.Now`). As sessões rodam
   com `TZ=UTC`; testes fixam o fuso explicitamente.
3. **TDD e testes intocáveis.** Teste que falha primeiro, depois o código. Nunca enfraqueça um
   teste: nada de apagar asserção, `.skip`/`.only`, trocar valor esperado sem prova, aumentar
   timeout para esconder lentidão, afrouxar lint/tsconfig ou limiar de cobertura. O lint
   (Biome com `biome-plugins/no-disabled-tests.grit`) barra `skip`/`only`/`todo`/`fails`; dica
   de exclusão de cobertura (`v8`/`c8`/`istanbul ignore`, `node:coverage`) quebra o meta-teste
   `test-hygiene` de cada pacote (e o ESLint de todos os pacotes, via `eslint.base.mjs`), e o
   hook `guard-files` pede confirmação. Teste que termina pulado ou pendente reprova a execução
   no core e em `pnpm test:root`/`pnpm test:hooks` (reporters próprios).
4. **Segurança por padrão** (OWASP Top 10:2025, API Top 10, ASVS 5.0 nível 2): zod estrito em
   toda entrada; autorização dentro de cada Server Action/Route Handler (o Proxy não autoriza);
   erros sem stack, SQL ou `DETAIL` do banco; fail-closed. Regras do domínio em
   `.claude/claude-security-guidance.md`.
5. **LGPD.** Minimização; nada de PII ou segredo em log, URL, analytics, Sentry ou prompt;
   anamnese é dado de saúde (consentimento específico, acesso por papel, criptografia).
6. **Migrações imutáveis.** Migração commitada não se edita: corrija com migração nova
   (forward-only). O runner aplica tudo numa transação; nada de `CONCURRENTLY`.
7. **Cadeia de suprimentos.** Dependência nova só com justificativa e versão exata;
   quarentena de 3 dias (`minimumReleaseAge`); `allowBuilds` explícito; `pnpm-lock.yaml` só
   pelo pnpm. Prefira não adicionar.
8. **Segredos** nunca no chat, no código ou em `.env*` versionado; só `.env.example` com
   valores falsos. Cite o NOME da variável.
9. **Git.** Trabalhe em branch; nunca push para `main`/`master`, `push --force` ou
   `--no-verify`/`LEFTHOOK=0`. Commits convencionais em pt-BR (skill `steward`).

## Fluxo de trabalho

1. Entenda o pedido e o código; pergunte só o que bloqueia.
2. Feature nova: skill `new-feature` (inclui threat model rápido, plano e TDD).
3. Implemente em passos pequenos, rodando os testes do pacote a cada passo.
4. Antes de cada commit: skill `verify`. Antes de PR: skill `pre-pr`.
5. Relate o que foi verificado e o que NÃO foi (e por quê). Nunca declare verde sem executar.

## Skills e agentes do projeto

| Situação | Use |
| --- | --- |
| Antes de commitar / "verifique" | skill `verify` |
| Funcionalidade nova ou mudança de comportamento | skill `new-feature` |
| Critérios de aceite, exploração da UI, regressão | skill `qa` (agente `qa-engineer`, MCP `playwright`) |
| Feature com dado pessoal, pagamento, auth, página pública | skill `threat-model` (agente `threat-modeler`) |
| Tocou autorização, queries, RLS, webhooks | skill `pentest-tenant` (agente `tenant-isolation-pentester`) |
| Revisão AppSec do diff | agente `appsec-reviewer`; auditoria completa: `/appsec-audit` |
| Migração ou schema | skill `review-migration` (agente `migration-reviewer`) |
| Dado pessoal, logs, integrações | skill `lgpd-check` (agente `lgpd-privacy-reviewer`) |
| Abrir/atualizar PR | skills `pre-pr` e `steward` |
| Bug ou teste falhando sem causa clara | `superpowers-systematic-debugging` |
| Confirmar se um achado de segurança é real | `tob-fp-check` |
| Testes de propriedade (fast-check) | `tob-property-based-testing` |

Skills e agentes com prefixo `tob-`, `sentry-`, `anthropic-`, `superpowers-` e `ms-` são de
terceiros (ver `THIRD_PARTY_NOTICES.md`); atualize-os só pelo `scripts/vendor-claude-skills.sh`.
Regras por caminho em `.claude/rules/` carregam sozinhas ao tocar banco, domínio ou servidor.

## Definition of Done

- Critérios de aceite cobertos por testes que falharam antes da implementação.
- Caso negativo cross-tenant para todo acesso a dado novo; RLS e constraints testadas com
  `pnpm test:db` quando o banco mudou.
- `pnpm verify` verde (inclui `knip`); `pnpm test:db`, `pnpm e2e` e `pnpm test:hooks` quando
  aplicável.
- Revisão de segurança (`pre-pr`) sem achado aberto, ou risco aceito e justificado no PR.
- Sem PII/segredo em código, log ou teste; dependências novas justificadas.
- Documentação e ADR atualizadas quando o comportamento ou a arquitetura mudou.

## Ambiente do agente

Hooks em `.claude/hooks/` bloqueiam comandos destrutivos (no Bash e no script do Monitor),
leitura de segredos, push perigoso, edição de lockfile e de migração publicada (fail-closed),
formatam/lintam o arquivo editado e
rodam o typecheck dos pacotes alterados ao final do turno. Se um hook bloquear, leia o motivo
e ajuste a abordagem; não tente contorná-lo.

Idioma: identificadores de código em inglês; documentação, mensagens de UI, commits e
comentários explicativos em pt-BR.
