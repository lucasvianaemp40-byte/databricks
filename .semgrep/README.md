# Regras próprias do Semgrep

Regras de segurança e de correção específicas do Agenda Salão. Rodam no job `SAST (Semgrep)` do
`.github/workflows/security.yml`, junto com os pacotes do registry (`p/default`,
`p/typescript`, `p/nextjs`, `p/react`, `p/nodejs`, `p/secrets`, `p/github-actions`). Todas têm
severidade `ERROR`, então qualquer achado novo bloqueia o PR.

| Regra | O que pega | Onde vale |
|---|---|---|
| `sql-raw-interpolation` | `sql.raw()` com valor não literal (inclusive com alias ou namespace do `drizzle-orm`); template ou concatenação escritos direto como texto de `query`/`execute` (1º argumento ou `{ text }`) | todo o código, exceto o DDL de `packages/db/src/schema/` |
| `sql-string-taint` | o mesmo SQL montado antes numa variável (`` const q = `...${x}`; client.query(q) ``, `+=`, `{ text: q }`), em modo taint; `escapeIdentifier`/`escapeLiteral` limpam o valor | todo o código, exceto o DDL de `packages/db/src/schema/` |
| `pii-in-logs` | nome, telefone, e-mail, CPF, observações, tokens ou o registro inteiro de cliente/usuário em `console`/`logger`, Sentry ou analytics, em qualquer subexpressão (concatenação, `JSON.stringify`, `{ data: customer }`, colchete, snake_case) | todo o código |
| `domain-clock` | `Date.now()`, `new Date()`, `Temporal.Now`, `Math.random()`, `crypto.randomUUID()` no domínio | `packages/scheduling-core/src/` (exceto `time/clock.ts`) |
| `server-timezone-date` | getters locais de `Date`, `toLocale*String`/`Intl.DateTimeFormat` sem `timeZone`, `new Date(ano, mês, ...)`, `new Date`/`Date.parse` com data-hora em texto sem `Z`/offset | `apps/` e `packages/`, fora de testes |
| `server-action-auth` | Server Action sem guarda `await requireXxx()` na primeira instrução (exportada de arquivo `'use server'` ou inline: declaração, arrow ou function expression), ou definida com o cliente base `actionClient` | arquivos `'use server'` e actions inline |
| `drizzle-tenant-scope` | `select/insert/update/delete/query` em tabela de tenant cujo receptor não é o `tx` do callback de `withTenant(...)` nem o parâmetro `TenantTransaction` da função (o `db` externo dentro de `withTenant` também é acusado) | `apps/` e `packages/`, exceto `packages/db` |
| `drizzle-tenant-alias` | tabela de tenant importada de `@salon/db` com alias, o que esconderia a query da regra acima | `apps/` e `packages/`, exceto `packages/db` |

As regras de tabela de tenant (`drizzle-tenant-*`) reconhecem a tabela pelo nome: são uma
heurística (não pegam `const t = customers` nem reexportação por módulo local). A RLS com
`FORCE` continua sendo a camada que faz esses erros falharem fechado.

## Testes das regras

Cada `rules/<regra>.yml` tem ao lado uma fixture `rules/<regra>.ts` com anotações
`// ruleid: <regra>` (deve achar na linha seguinte) e `// ok: <regra>` (não pode achar). O CI
roda antes da varredura:

```bash
semgrep --test --metrics=off .semgrep/rules
```

O modo de teste ignora o filtro `paths` das regras. As fixtures contêm código vulnerável de
propósito e por isso ficam fora da varredura (`.semgrepignore`) e do CodeQL
(`.github/codeql/codeql-config.yml`).

Para rodar a varredura local só com as regras próprias (sem rede):

```bash
semgrep scan --metrics=off --config .semgrep/rules .
```

## Falso positivo

Corrija a regra (com caso `// ok:` novo na fixture) quando o padrão for legítimo e recorrente.
Para uma exceção pontual, comente na linha, com o motivo, e explique no PR:

```ts
// nosemgrep: sql-raw-interpolation -- SET não aceita parâmetro; valor validado como inteiro.
```
