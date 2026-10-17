# Regras próprias do Semgrep

Regras de segurança e de correção específicas do Agenda Salão. Rodam no job `SAST (Semgrep)` do
`.github/workflows/security.yml`, junto com os pacotes do registry (`p/default`,
`p/typescript`, `p/nextjs`, `p/react`, `p/nodejs`, `p/secrets`, `p/github-actions`). Todas têm
severidade `ERROR`, então qualquer achado novo bloqueia o PR.

| Regra | O que pega | Onde vale |
|---|---|---|
| `sql-raw-interpolation` | `sql.raw()` com valor não literal; template ou concatenação passados a `query`/`execute` | todo o código, exceto o DDL de `packages/db/src/schema/` |
| `pii-in-logs` | nome, telefone, e-mail, CPF, observações, tokens ou o registro inteiro de cliente/usuário em `console`/`logger` | todo o código |
| `domain-clock` | `Date.now()`, `new Date()`, `Temporal.Now`, `Math.random()`, `crypto.randomUUID()` no domínio | `packages/scheduling-core/src/` (exceto `time/clock.ts`) |
| `server-timezone-date` | getters locais de `Date`, `toLocale*String`/`Intl.DateTimeFormat` sem `timeZone`, `new Date(ano, mês, ...)` | `apps/` e `packages/`, fora de testes |
| `server-action-auth` | Server Action exportada sem guarda `await requireXxx()` na primeira instrução, ou definida com o cliente base `actionClient` | arquivos `'use server'` e actions inline |
| `drizzle-tenant-scope` | `select/insert/update/delete/query` em tabela de tenant fora de `withTenant(...)` ou de função com `tx: TenantTransaction` | `apps/` e `packages/`, exceto `packages/db` |

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
