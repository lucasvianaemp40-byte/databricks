# ADR-0001: Monorepo pnpm + Turborepo e stack com versões

- **Status:** Aceito
- **Data:** 2026-10-17
- **Relacionados:** [ADR-0007](0007-politica-de-supply-chain.md) (supply chain),
  [ADR-0009](0009-lint-biome-eslint.md) (lint), [arquitetura](../arquitetura.md)

## Contexto

O produto tem um app web, um domínio de agendamento que precisa ser puro e testável por
propriedades, uma camada de dados com regras de segurança no banco e, em breve, um worker.
Os três compartilham tipos e regras (por exemplo, a máquina de estados do agendamento existe
no core e no trigger do banco). A equipe é pequena e usa agentes de IA, então a stack precisa
ser mainstream, bem documentada e com patch de segurança rápido.

Fatos verificados no registry npm e nos repositórios em 16/10/2026 (detalhes nas referências):

- Node 24 é LTS até entrar em manutenção em 20/10/2026. Node 26 vira LTS em 28/10/2026 e traz
  Temporal habilitado por padrão.
- pnpm 10.28.0 (o que vinha no container) tem advisories altos corrigidos só a partir de
  10.34.5. O pnpm 11 traz defaults de supply chain (`minimumReleaseAge`, `strictDepBuilds`,
  `blockExoticSubdeps`). O pnpm 12 saiu em 26/08/2026 com churn alto e grava lockfile de dois
  documentos, que alguns scanners não leem.
- Next.js teve muitos advisories em 2025–2026, entre eles RCE no protocolo Flight
  ([GHSA-fv66-9v8q-g76r](https://github.com/advisories/GHSA-fv66-9v8q-g76r)), vários bypasses
  de middleware e proxy, e RCEs críticos em ago–set/2026
  ([GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36),
  [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j)). A versão mínima
  segura da linha 16 é **16.3.8**.
- TypeScript 7.0.2 (compilador nativo) não expõe a API JS clássica, e o typescript-eslint
  8.71.2 exige `typescript <6.1.0`.
- Drizzle ORM: SQL injection por identificadores corrigida em 0.45.2
  ([GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9)).

## Decisão

**Monorepo pnpm 11 + Turborepo**, com três pacotes:

| Pacote | Nome | Papel |
|---|---|---|
| `apps/web` | `@salon/web` | Next.js App Router: UI, Server Actions, Route Handlers, Proxy |
| `packages/scheduling-core` | `@salon/scheduling-core` | domínio puro |
| `packages/db` | `@salon/db` | schema, migrações, RLS, `withTenant` |

- Os **pacotes internos exportam o fonte TypeScript** (sem build). O Next os transpila via
  `transpilePackages`, e o worker será empacotado com um bundler quando existir.
- O **catálogo do pnpm** (`catalog:`) fixa uma versão por dependência para o monorepo
  inteiro, com `saveExact`.
- O **Turborepo** roda em modo estrito de env: variável não declarada é filtrada. `test:db` e
  `e2e` não usam cache.
- **Node:** `.nvmrc` = `24` em CI e produção. `engines.node` = `>=22.22.0`, para aceitar o
  container de desenvolvimento.
- **pnpm via Corepack:** `"packageManager": "pnpm@11.28.5+sha512…"`, com o hash conferido
  contra a integrity do registry.

Versões instaladas na fundação (fonte de verdade: [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml)):

| Camada | Versão |
|---|---|
| pnpm / Turborepo | 11.28.5 / 2.11.8 |
| TypeScript / @types/node | 6.0.3 / 24.19.2 |
| Next.js / React / React DOM | 16.4.0 / 19.3.0 / 19.3.0 |
| Tailwind CSS / PostCSS | 4.3.3 / 8.5.30 |
| Zod / @t3-oss/env-nextjs | 4.6.7 / 0.13.11 |
| temporal-polyfill | 1.0.6 |
| drizzle-orm / drizzle-kit / pg / uuid | 0.45.4 / 0.31.11 / 8.23.1 / 14.0.3 |
| Vitest / fast-check / @fast-check/vitest | 5.0.4 / 4.10.2 / 0.5.0 |
| Playwright / @axe-core/playwright | 1.64.0 / 4.13.0 |
| Biome / ESLint / typescript-eslint | 2.5.15 / 10.12.0 / 8.71.2 |
| lefthook / commitlint / knip | 2.2.1 / 21.2.3 / 6.41.0 |

**Desvios em relação à pesquisa**, por causa da quarentena de 3 dias
([ADR-0007](0007-politica-de-supply-chain.md)): sete versões recomendadas tinham menos de 3
dias na instalação e entrou a mais nova fora da quarentena. Next e `@next/eslint-plugin-next`
ficaram em 16.4.0 em vez de 16.4.2 (ainda acima do piso 16.3.8). React e React DOM em 19.3.0
(recomendado 19.3.1). Vitest em 5.0.4 (5.0.5), Playwright em 1.64.0 (1.64.1), axe em 4.13.0
(4.14.0), ESLint em 10.12.0 (10.13.0) e Turborepo em 2.11.8 (2.11.9). O lefthook ficou em
2.2.1: a 2.2.2 saiu sem trusted publisher nem provenance e foi barrada pelo
`trustPolicy: no-downgrade`. O endpoint de advisories do npm não retornou nada para nenhuma
dessas versões. Revisar quando as recomendadas passarem da quarentena (o Renovate abre os PRs).

## Consequências

- **Positivas:**
  - tipos e regras compartilhados sem publicar pacotes;
  - um único lockfile e uma única política de supply chain;
  - cache do Turborepo: uma mudança no core invalida o typecheck do web, mas não o do db;
  - o domínio puro fica isolado por lint.
- **Negativas e riscos:**
  - o Next.js exige disciplina de patch, com correção crítica em até 48 h quando houver
    advisory (Renovate com PR de vulnerabilidade fora da quarentena);
  - o pnpm 11 não tem suporte documentado pela Vercel (há relato de contorno com
    `ENABLE_EXPERIMENTAL_COREPACK=1`, não verificado oficialmente). Testar no primeiro deploy
    ou publicar com `vercel deploy --prebuilt` pelo Actions;
  - TypeScript 6 em vez de 7: migrar quando o typescript-eslint suportar o 7. O tsconfig já é
    compatível (sem `baseUrl`, `moduleResolution: Bundler`, `erasableSyntaxOnly`);
  - pacotes internos sem build dependem de o consumidor transpilar.
- **Ações decorrentes:**
  - migrar CI e produção para o **Node 26** depois do LTS. Ele traz Temporal nativo: trocar o
    import de `temporal-polyfill` num só lugar ([ADR-0003](0003-tempo-e-fusos-temporal.md)). O
    Corepack deixou de ser distribuído com o Node a partir da v25 (decisão do TSC do Node.js;
    não verificado nesta pesquisa), então confirme como ativar o pnpm ao migrar;
  - acompanhar o Drizzle 1.0, que estava em RC na data desta decisão.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| TanStack Start 1.x | Ecossistema menor para auth, observabilidade e UI; data do "1.0 estável" conflitante entre fontes. Seria a segunda opção para sair do acoplamento a RSC/Vercel |
| React Router 8 (framework mode) | Major recente (jun/2026), exige React ≥ 19.2.7. Sólido, mas com menos material e integrações |
| Prisma 7 | Codegen e schema próprio. A dist-tag `latest` do CLI `prisma` apontava para um RC (`8.0.0-rc.23`), uma armadilha. RLS só via SQL cru |
| Kysely | Só query builder, sem migrações declarativas nem `pgPolicy` no schema |
| pnpm 10 | Defaults inseguros e sem reaplicação de políticas ao lockfile. Única vantagem: suporte oficial do Dependabot |
| pnpm 12 | Lockfile de dois documentos (scanners leem "zero dependências" sem erro) e churn alto |
| TypeScript 7 | Sem API JS estável. Quebra typescript-eslint e Stryker |
| Nx | Mais poder do que o necessário para três pacotes; o Turborepo basta |

## Referências

- Agenda de releases do Node.js: https://github.com/nodejs/Release (`schedule.json`)
- Notas do pnpm 11: https://github.com/pnpm/pnpm/releases/tag/v11.0.0
- Advisories do Next.js: https://github.com/vercel/next.js/security/advisories
- Advisory do Drizzle: https://github.com/advisories/GHSA-gpj5-g38j-94v9
- Peer dependencies do typescript-eslint 8.71.2 (registry npm)
