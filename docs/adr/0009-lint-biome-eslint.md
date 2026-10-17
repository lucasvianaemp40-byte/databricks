# ADR-0009: Lint e formatação com Biome + ESLint enxuto

- **Status:** Aceito
- **Data:** 2026-10-17
- **Relacionados:** [`biome.json`](../../biome.json), [`eslint.base.mjs`](../../eslint.base.mjs),
  [ADR-0003](0003-tempo-e-fusos-temporal.md) (regras de relógio)

## Contexto

Precisamos de três coisas:

1. formatação e lint rápidos, que caibam no pre-commit;
2. regras que dependem de tipos (`no-floating-promises`, `no-misused-promises`,
   `switch-exhaustiveness-check`);
3. regras de segurança e de domínio: pureza do core, relógio e aleatoriedade.

Fatos verificados em 16/10/2026:

- **Biome 2.5.15:**
  - o grupo `security` tem só 6 regras (`noSecrets`, `noDangerouslySetInnerHtml`,
    `noGlobalEval` e outras);
  - as regras type-aware equivalentes estão em *nursery*;
  - tem `noImportCycles` e *domains* `next`, `react`, `test`, `playwright`, `drizzle`,
    `tailwind`, `turborepo` e `project`.
- **ESLint:** o 9 está em fim de vida desde 06/08/2026. O `eslint-config-next` 16.4 puxa
  `eslint-plugin-react`, `jsx-a11y` e `import`, cujo peer para no ESLint 9.
- **typescript-eslint 8.71.2** tem `strictTypeChecked` estável e exige TypeScript < 6.1.
- **eslint-plugin-security 4.2.0** traz 14 regras (regex inseguro, `child_process`, `eval`
  com expressão, timing attack, caracteres bidi e outras).
- O repositório do Better Auth usa Biome + lefthook + turbo + pnpm 11.

## Decisão

**Híbrido, sem Prettier:**

- **Biome** faz toda a formatação e o lint geral. Usa preset `recommended` e os domínios
  acima, com:
  - `noSecrets`, `noDangerouslySetInnerHtml`, `noGlobalEval`;
  - `noImportCycles`, `noExplicitAny`, `noUnusedImports`, `noUnusedVariables`;
  - `useImportType`, `useNodejsImportProtocol`, `noNonNullAssertion` (desligada em testes);
  - JSON sempre expandido.

  Roda no pre-commit (`biome check --write` nos arquivos staged) e em `pnpm lint`.
- **ESLint 10 enxuto**, por pacote, a partir de
  `createBaseConfig({ tsconfigRootDir })`:
  - `@eslint/js` recommended + `typescript-eslint` **`strictTypeChecked`**;
  - `switch-exhaustiveness-check`, `restrict-template-expressions`,
    `consistent-type-assertions` (sem asserção de objeto literal) e
    `no-import-type-side-effects`;
  - `reportUnusedDisableDirectives: error`;
  - **`eslint-plugin-security`** recommended, com `detect-object-injection` desligada (ruído
    em TS; o risco real é coberto por `noUncheckedIndexedAccess`);
  - no app web, `@next/eslint-plugin-next` e `eslint-plugin-react-hooks`, sem
    `eslint-config-next`. A regra `no-html-link-for-pages` fica desligada porque só se aplica
    ao Pages Router.
- **Domínio puro** (`createPureDomainConfig`), aplicado a `packages/scheduling-core/src/**`,
  proíbe:
  - `Date.now`, `new Date()` sem argumento, `Date()`, `Temporal.Now` e `performance.now`;
  - `Math.random`, `crypto.randomUUID` e `crypto.getRandomValues`;
  - getters e setters locais de `Date` e `resolvedOptions`;
  - globais de I/O;
  - imports de builtins do Node, `pg`, `drizzle-orm`, `next`, `react`, `@salon/db` e
    `temporal-polyfill/global`.

  O único ponto autorizado a ler o relógio real é o `systemClock`, com
  `eslint-disable` justificado. Um teste (`test/lint-rules.test.ts`) prova que as regras
  disparam.
- **Semgrep** complementa com regras próprias em [`.semgrep/rules/`](../../.semgrep/rules):

  | Regra | O que pega |
  |---|---|
  | `domain-clock` | leitura de relógio no domínio |
  | `drizzle-tenant-scope` | acesso a tabela de tenant fora do `withTenant` |
  | `pii-in-logs` | dado pessoal em log |
  | `server-action-auth` | Server Action sem guarda de sessão e tenant |
  | `server-timezone-date` | data formatada no fuso do servidor |
  | `sql-raw-interpolation` | `sql.raw` com interpolação |

  Cada regra tem fixture de teste ao lado.
- **Commits:** commitlint com Conventional Commits, assunto em pt-BR, `subject-case`
  desligado (siglas como LGPD, RLS e Pix) e escopos conhecidos (`web`, `core`, `db`, `ci`,
  `claude`, `docs`, `deps`, `repo`, `security`) como aviso.

## Consequências

- **Positivas:**
  - pre-commit em milissegundos;
  - regras type-aware e de segurança estáveis;
  - pureza do domínio garantida por ferramenta, não por revisão;
  - sem conflito entre formatadores.
- **Negativas e riscos:**
  - duas ferramentas para manter e configurar. Regras sobrepostas ficam no Biome, e o ESLint
    nunca formata;
  - plugins sem peer declarado para o ESLint 10 (`@next/eslint-plugin-next`,
    `eslint-plugin-security`) foram verificados em execução na fundação, mas podem quebrar
    numa atualização (o Renovate agrupa as ferramentas de lint);
  - no ESLint, uma segunda declaração de `no-restricted-syntax` **substitui** a primeira em vez
    de somar. Por isso `pureDomainRestrictedSyntax` é exportado para composição.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| ESLint + Prettier (com `eslint-config-next`) | Mais lento no pre-commit, e o `eslint-config-next` arrasta plugins sem suporte ao ESLint 10 |
| Só Biome | Sem regras type-aware estáveis, sem `eslint-plugin-security` e sem regras de domínio com seletores AST |
| oxlint | Não avaliado em profundidade nesta pesquisa. Reavaliar quando cobrir regras type-aware |

## Referências

- Biome: https://biomejs.dev/
- typescript-eslint: https://typescript-eslint.io/users/configs#strict-type-checked
- eslint-plugin-security: https://github.com/eslint-community/eslint-plugin-security
- Fim de vida do ESLint 9: https://github.com/eslint/eslint (`docs/src/_includes/partials/deprecation-notice.html`)
