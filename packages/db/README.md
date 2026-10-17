# @salon/db

Camada de dados do Agenda Salão: schema PostgreSQL (Drizzle ORM 0.45), migrações, isolamento
multi-tenant por Row Level Security e a única porta de acesso a dados de tenant, `withTenant`.

Compatível com PostgreSQL 16 e 18: nenhum recurso exclusivo do 17/18, UUIDv7 gerado na
aplicação. Um teste estático verifica isso nas migrações. A suíte de integração foi executada
em PostgreSQL 16.15 local; o CI (postgres 18.6) é a fonte de verdade para o 18.

## Uso

```ts
import { createDb, customers, withTenant, SlotUnavailableError } from '@salon/db';

// Papel app_user: NUNCA a URL do dono/superusuário (ignoraria a RLS).
const db = createDb(env.DATABASE_URL);

// tenantId vem SEMPRE da sessão autenticada (membership), nunca do corpo/URL da requisição.
const rows = await withTenant(
  db,
  session.tenantId,
  (tx) => tx.select().from(customers),
  { actor: { type: 'staff', id: session.userId }, readOnly: true },
);
```

- `withTenant(db, tenantId, fn, options?)` valida o UUID antes de tocar no banco, abre uma
  transação e define `set_config('app.tenant_id', id, true)`. O escopo é a transação, então é
  seguro com pool e com PgBouncer em modo transaction. Também fixa `TimeZone=UTC` e
  `DateStyle=ISO` e registra o ator da auditoria (`app.actor_type`/`app.actor_id`).
- Erros do banco saem traduzidos:

  | SQLSTATE | Erro | Quando |
  |---|---|---|
  | 23P01 | `SlotUnavailableError` | horário do profissional ocupado (inclui corrida entre duas reservas) |
  | 42501 | `TenantIsolationError` | RLS recusou a linha ou falta privilégio; responda 404 |
  | 23514 (trigger) | `InvalidStatusTransitionError` | transição de status proibida |
  | 23505 (`idempotency_key`) | `IdempotencyKeyConflictError` | comando de criação repetido |

  Os demais erros passam inalterados. Nenhuma mensagem inclui o `DETAIL` do PostgreSQL,
  porque ele pode conter dados pessoais.
- `newId()` gera um UUIDv7 (as PKs já usam por padrão). É previsível, então nunca use como
  segredo.
- O pacote não importa `server-only`, para rodar em testes e scripts. O app web deve importá-lo
  apenas de módulos de servidor.

## Modelo (schema `app`)

| Tabela | Conteúdo |
|---|---|
| `tenants` | salão (raiz do isolamento; `slug` público e único global) |
| `locations` | unidade, com **fuso IANA** validado contra o tzdata e regras do agendamento online |
| `staff` | profissional com vínculo `owner`, `employee`, `partner` ou `freelancer` |
| `services` | duração, fases (`ServicePhase` do core: `work`/`pause`), buffers, preço em centavos e comissão em bps |
| `staff_services` | overrides de preço, duração e comissão por profissional |
| `working_hours` | jornada semanal em hora de parede, com vigência (EXCLUDE contra sobreposição) |
| `time_off` | bloqueios em instantes absolutos (`during` tstzrange gerada) |
| `customers` | nome, telefone E.164 (único **por tenant**), e-mail opcional e consentimentos mínimos; anonimização LGPD |
| `appointments` | visita: status (máquina de estados do core), unidade, fuso, hora de parede, instantes de cada transição, `idempotency_key` única por tenant, `version` |
| `appointment_items` | serviço x profissional com preço e comissão **congelados** |
| `occupancies` | ocupação do profissional; `EXCLUDE (tenant_id =, staff_id =, during &&) WHERE active` |
| `appointment_events` | auditoria **append-only** das transições, escrita só por trigger |

Toda tabela de tenant tem `tenant_id NOT NULL` (default vindo do contexto), PK `uuid`, FKs
compostas `(tenant_id, id)` e UNIQUEs começando por `tenant_id`. Assim, nem com o UUID de outro
salão dá para referenciar a linha dele, e nenhuma unicidade vaza existência entre tenants.

## Segurança multi-tenant (defesa em profundidade)

1. **Papéis.** `app_migrator` (NOLOGIN) é dono de tudo. `app_user` (web) e `app_worker` (jobs)
   são LOGIN, NOSUPERUSER e NOBYPASSRLS, não são donos de nada, não herdam papel nenhum e não
   têm TRUNCATE, REFERENCES nem TRIGGER. Nenhum papel recebe senha no repositório.
2. **RLS ENABLE + FORCE** em toda tabela de tenant e em `tenants`. Uma política RESTRICTIVE
   `tenant_isolation`, para PUBLIC e inclusive para o dono, exige
   `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`. Uma política
   PERMISSIVE `app_access` concede acesso aos papéis da aplicação. Sem contexto, o resultado
   são 0 linhas, sem erro. O `NULLIF` evita o erro 22P02 quando o GUC volta como `''` na mesma
   conexão.
3. **Integridade no banco.** CHECKs (status, E.164, fuso, fases), EXCLUDE anti-overbooking,
   máquina de estados em trigger (espelho de `allowedTransitions()` de `@salon/scheduling-core`),
   `occupancies.active` **derivada** do status (a aplicação não consegue "esconder" uma ocupação)
   e auditoria `SECURITY DEFINER`: a aplicação só lê `appointment_events`. Um trigger recusa
   UPDATE, DELETE e TRUNCATE até para o dono.
4. **Invariantes no deploy.** `app_private.assert_security_invariants()` roda ao fim de **toda**
   execução do runner. Se alguma tabela com `tenant_id` estiver sem RLS/FORCE/política
   RESTRICTIVE, se houver papel com BYPASSRLS, privilégio a mais (inclusive de coluna) ou função
   SECURITY DEFINER executável pela aplicação, nada é commitado.

Limitação conhecida: qualquer sessão pode chamar `set_config`. A RLS confia que só o código do
servidor define o contexto (SQL parametrizado; `sql.raw` só com constantes). A primeira camada
de autorização continua sendo o DAL do app.

## Migrações

As migrações ficam em `drizzle/`. São **imutáveis depois de commitadas**: o runner recusa uma
migração aplicada cujo arquivo mudou.

| Migração | Roda como | Conteúdo |
|---|---|---|
| `0000_bootstrap_roles_extensions` | usuário da conexão (marcador `-- @salon/db run-as: session-user`) | `btree_gist` e papéis (idempotente; corrige atributos perigosos) |
| `0001_private_functions` | `app_migrator` | schema `app_private`, validações usadas em CHECK, tipo `time_range` |
| `0002_schema` | `app_migrator` | gerada pelo drizzle-kit a partir de `src/schema` |
| `0003_tenant_security` | `app_migrator` | triggers, EXCLUDE, RLS, GRANTs e função de invariantes |

```bash
pnpm --filter @salon/db generate --name=<descricao>   # mudou src/schema
pnpm --filter @salon/db generate:custom <nome>          # RLS/GRANT/trigger/EXCLUDE (SQL manual)
DATABASE_URL_MIGRATOR=... pnpm --filter @salon/db migrate
```

O runner (`src/migrate.ts`, exportado em `@salon/db/migrate`) usa a mesma contabilidade do
Drizzle (`drizzle.__drizzle_migrations`). Além disso:

- serializa deploys simultâneos com `pg_advisory_xact_lock`;
- aplica tudo em uma única transação, com `lock_timeout`;
- recusa migração nova com timestamp anterior à última aplicada (o Drizzle a pularia em
  silêncio) e recusa banco à frente do código.

Nunca use `drizzle-kit push`/`migrate`.

**Checklist para tabela nova de tenant:** `tenant_id` com `tenantIdColumn()`, FKs compostas,
UNIQUEs começando por `tenant_id`; numa migração custom, `ENABLE` + `FORCE` RLS,
`tenant_isolation` RESTRICTIVE, `app_access` PERMISSIVE, GRANTs explícitos e trigger de
`updated_at`. Se faltar algo, o runner e os meta-testes falham.

## Testes

| Comando | O que roda |
|---|---|
| `pnpm --filter @salon/db test` | unidade, sem banco: erros, ids, validação de `withTenant`, runner, **drift** entre schema e migrações, paridade do trigger SQL com o core |
| `pnpm test:db` (raiz) ou `pnpm --filter @salon/db test:db` | integração e RLS no PostgreSQL real |

`test:db` usa `TEST_DATABASE_URL` (superusuário de um cluster **de teste**). Sem ela,
`scripts/with-local-postgres.sh` sobe um PostgreSQL efêmero com os binários locais. O global
setup cria um banco descartável, aplica as migrações com o runner de produção, define senhas
aleatórias para `app_user`/`app_worker` e apaga o banco ao final. Os arquivos rodam em série
(`pool: 'forks'`, `fileParallelism: false`).

Cobertura de integração:

- isolamento em todas as tabelas: leitura, UPDATE, DELETE, INSERT com tenant alheio, UPDATE
  trocando `tenant_id`, sem contexto, FK cruzada e `app_worker`;
- regressão `'' -> 22P02` do GUC na mesma conexão;
- EXCLUDE: sobreposição, intervalos encostados, cancelado/no-show liberando, reativação
  colidindo e corrida controlada e real (exatamente uma vence);
- os 81 pares da máquina de estados;
- auditoria append-only e meta-testes de catálogo, inclusive sabotagens que a função de
  invariantes precisa detectar;
- runner: idempotência, lock concorrente, imutabilidade e rollback.

## Variáveis de ambiente

Veja `.env.example`. Resumo: `DATABASE_URL` (app_user), `DATABASE_URL_WORKER` (app_worker),
`DATABASE_URL_MIGRATOR` (superusuário/admin, só no deploy) e `TEST_DATABASE_URL` (testes).

## Produção (pendências documentadas)

- Senhas de `app_user`/`app_worker` são definidas fora do repositório (`ALTER ROLE ... PASSWORD`
  via IaC/console). Use TLS (`sslmode=verify-full`).
- O admin que roda as migrações precisa de CREATEROLE e de `SET` em `app_migrator`. O bootstrap
  concede o `SET` a quem criou o papel. Em provedores como o Neon, papéis criados pelo console
  entram em grupos com BYPASSRLS, então crie `app_*` **por SQL** (é o que a migração 0000 faz).
  A função de invariantes recusa papel de runtime com BYPASSRLS ou que herde outro papel.
- Manutenção que altera status precisa definir `app.tenant_id`. Sem contexto, nem o
  superusuário consegue mudar status, porque o trigger de auditoria é barrado pela RLS.
- Ainda não implementado (próximas iterações): tabelas do Better Auth (schema `auth`, papel
  `app_auth`); resolução pública `slug -> tenant` para a página de agendamento (função
  `SECURITY DEFINER` dedicada, já que `tenants` só é visível ao próprio tenant); job de
  expiração de holds e de no-show (pg-boss, papel `app_worker`); procedimento privilegiado de
  exclusão de tenant e retenção (LGPD), lembrando que `appointment_events` bloqueia DELETE.
