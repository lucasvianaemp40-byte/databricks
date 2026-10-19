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
  transação **READ COMMITTED** (fixa, vence o `default_transaction_isolation` do banco, do
  papel ou da URL) e define `set_config('app.tenant_id', id, true)`. O escopo é a transação,
  então é seguro com pool e com PgBouncer em modo transaction. Também fixa `TimeZone=UTC` e
  `DateStyle=ISO` e registra o ator da auditoria (`app.actor_type`/`app.actor_id`).
- **O `tx` só vale enquanto `fn` executa.** Toda consulta precisa terminar antes de `fn`
  resolver: nada de fire-and-forget, `after()` ou builder devolvido dentro de um objeto para
  executar depois; em `Promise.all` com ramos que podem falhar, use `Promise.allSettled` (ou
  aguarde cada ramo). O Drizzle devolve a conexão ao pool sem invalidar o `tx`, e uma consulta
  atrasada rodaria na transação de OUTRA requisição, com o tenant dela (a RLS não perceberia).
  Por isso `withTenant` embrulha a conexão: depois do callback só passam o COMMIT/ROLLBACK, e
  qualquer outra consulta é recusada com `TransactionClosedError` sem tocar no banco. Conexão
  com transação sem desfecho limpo, com consulta ainda em voo ou que emitiu erro é destruída
  em vez de voltar ao pool. Enquanto emprestada, a conexão tem um ouvinte de `error` (o pool
  tira o dele): uma queda no meio do callback (failover, `pg_terminate_backend`) não vira
  exceção não capturada; o erro chega pela consulta seguinte ou pelo COMMIT.
- **`fn` pode rodar mais de uma vez.** Em deadlock (40P01) ou falha de serialização (40001), o
  PostgreSQL abortou a transação para resolver um conflito com outra, e a documentação dele
  manda repetir a transação inteira. `withTenant` repete numa conexão nova, até 3 tentativas
  com espera aleatória curta (até 25 ms e depois 50 ms); se persistir, lança
  `TransactionConflictError`. Dentro de `fn`, só trabalho na transação: e-mail, HTTP ou fila
  fora do banco vão depois do commit (a fila do pg-boss, na mesma transação, pode).
- Erros do banco saem traduzidos:

  | SQLSTATE | Erro | Quando |
  |---|---|---|
  | 23P01 | `SlotUnavailableError` | horário do profissional ocupado (inclui corrida entre duas reservas) |
  | 42501 | `TenantIsolationError` | RLS recusou a linha ou falta privilégio; responda 404 |
  | 23514 (trigger) | `InvalidStatusTransitionError` | transição de status proibida |
  | 23505 (`idempotency_key`) | `IdempotencyKeyConflictError` | comando de criação repetido |
  | 23505 (`<tabela>_pkey`) | `IdentifierConflictError` | id já usado, possivelmente por OUTRO tenant; responda genérico (404/409), nunca "já existe" |
  | 40P01, 40001 | `TransactionConflictError` | conflito com outra transação que persistiu depois das 3 tentativas; responda 503 com `Retry-After` curto |
  | (nenhum) | `TransactionClosedError` | `tx` usado depois do fim do callback (bug do chamador) |

  Os demais erros passam inalterados. Nenhuma mensagem de erro traduzido inclui o `DETAIL` do
  PostgreSQL, porque ele pode conter dados pessoais. Atenção: o `DrizzleQueryError` que passa
  inalterado (e que fica em `cause` dos traduzidos) traz os parâmetros da consulta na
  mensagem; não o registre cru em log.
- `newId()` gera um UUIDv7 (as PKs já usam por padrão). É previsível, então nunca use como
  segredo. Ids nascem no servidor: não aceite `id` (nem `tenant_id`) vindo do cliente em
  INSERT/upsert, nem UPDATE de `id`.
- O pacote não importa `server-only`, para rodar em testes e scripts. O app web deve importá-lo
  apenas de módulos de servidor.

## Modelo (schema `app`)

| Tabela | Conteúdo |
|---|---|
| `tenants` | salão (raiz do isolamento; `slug` público e único global) |
| `locations` | unidade, com **fuso IANA** validado contra o tzdata (nome `Area/Local` sem dígito: recusa offset fixo, inclusive `Etc/GMT+3`, e o fallback POSIX do PostgreSQL) e regras do agendamento online |
| `staff` | profissional com vínculo `owner`, `employee`, `partner` ou `freelancer` |
| `services` | duração, fases (`ServicePhase` do core: `work`/`pause`), buffers, preço em centavos e comissão em bps |
| `staff_services` | overrides de preço, duração e comissão por profissional |
| `working_hours` | jornada semanal em hora de parede (minuto cheio; o core usa `HH:MM`), com vigência (EXCLUDE contra sobreposição) |
| `time_off` | bloqueios em instantes absolutos (`during` tstzrange gerada) |
| `customers` | nome, telefone E.164 (único **por tenant**), e-mail opcional e consentimentos mínimos; anonimização LGPD |
| `appointments` | visita: status (máquina de estados do core), unidade, fuso da unidade, hora de parede **com o offset UTC** daquela ocorrência (coerência hora de parede = instante + offset por CHECK), instantes de cada transição (gravados pelo banco), `idempotency_key` única por tenant, `version`; unidade, fuso e horário imutáveis (remarcar = novo agendamento) |
| `appointment_items` | serviço x profissional com duração, fases, buffers, preço e comissão **congelados**; profissional, horário, fases e buffers imutáveis |
| `occupancies` | ocupação do profissional, amarrada ao item; `EXCLUDE (tenant_id =, staff_id =, during &&) WHERE active` |
| `appointment_events` | auditoria **append-only** das transições, escrita só por trigger |

Toda tabela de tenant tem `tenant_id NOT NULL` (default vindo do contexto), PK `uuid`, FKs
compostas `(tenant_id, id)` e UNIQUEs de negócio começando por `tenant_id`. Assim, nem com o
UUID de outro salão dá para referenciar a linha dele, e nenhuma UNIQUE de negócio (telefone,
slug da unidade, `idempotency_key`) vaza existência entre tenants.

Exceção: a PK `id` é **global**. Um INSERT, upsert ou UPDATE com um `id` que já existe em outro
tenant recebe 23505 (`IdentifierConflictError`) mesmo com a RLS escondendo a linha, e um
`ON CONFLICT (id)` devolve 0 linhas ou 42501. Isso não vaza nada porque o id é sempre gerado
no servidor e nunca muda; a PK não vira `(tenant_id, id)` de propósito, para que um id nunca
se repita entre salões (jobs, logs e caches indexados só pelo id).

Horários de agenda (`starts_at`/`ends_at` de agendamento, item, ocupação e bloqueio) têm
precisão de **milissegundo** (CHECK `<tabela>_instant_precision`): o `Date` do driver descarta
microssegundos, e um fim arredondado para dentro faria o motor oferecer um horário que o
EXCLUDE recusa. SQL manual ou job usa `date_trunc('milliseconds', ...)`.

## Segurança multi-tenant (defesa em profundidade)

1. **Papéis.** `app_migrator` (NOLOGIN, NOINHERIT, membro de nenhum papel) é dono de tudo; o
   bootstrap corrige um `app_migrator` reaproveitado com LOGIN/INHERIT/senha e recusa um que
   seja membro de outro papel. `app_user` (web) e `app_worker` (jobs) são LOGIN, NOSUPERUSER e
   NOBYPASSRLS, não são donos de nada, não herdam papel nenhum e não têm TRUNCATE, REFERENCES
   nem TRIGGER. `app_worker` só lê e altera `appointments.status` (GRANT de coluna; o trigger
   sincroniza as ocupações). Nenhum papel recebe senha no repositório.
2. **RLS ENABLE + FORCE** em toda tabela de tenant e em `tenants`. Uma política RESTRICTIVE
   `tenant_isolation`, para PUBLIC e inclusive para o dono, exige
   `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`. Uma política
   PERMISSIVE `app_access` concede acesso aos papéis da aplicação. Sem contexto, o resultado
   são 0 linhas, sem erro. O `NULLIF` evita o erro 22P02 quando o GUC volta como `''` na mesma
   conexão.
3. **Integridade no banco.** CHECKs (status, E.164, fuso, fases, minuto cheio, precisão de
   milissegundo, coerência hora de parede/offset), EXCLUDE anti-overbooking, máquina de
   estados em trigger (espelho de `allowedTransitions()` de `@salon/scheduling-core`) que
   também grava os instantes de transição e o hold (o valor enviado pela aplicação é
   ignorado, assim como `created_at`/`updated_at`), fuso do agendamento = fuso da unidade,
   unidade/fuso/horário da visita imutáveis, e auditoria `SECURITY DEFINER`: a aplicação só lê
   `appointment_events`. Um trigger recusa UPDATE, DELETE e TRUNCATE até para o dono. A
   aplicação não consegue esconder nem desalinhar uma ocupação:
   - `occupancies.active` é **derivada** do status (sem agendamento visível, fica `false`);
   - a FK composta com o item inclui `staff_id` (ocupação é do profissional do item) e um
     trigger exige que o trecho caiba na janela do item ampliada pelos buffers congelados;
   - a aplicação só faz INSERT e UPDATE de `active` em `occupancies` (sem DELETE nem UPDATE de
     profissional, horário ou item);
   - profissional, horário, duração, fases e buffers do item são imutáveis, e item com
     ocupação ativa não é apagado (remarcar = novo agendamento);
   - no COMMIT (constraint trigger adiada), todo agendamento que ocupa a agenda tem itens
     dentro da janela da visita, e as ocupações `service` ativas de cada item cobrem todas as
     fases `work` congeladas no item (uma ocupação de 1 minuto num serviço de 1 hora não passa;
     a pausa de um serviço multi-etapa fica livre para outro cliente).

   A serialização entre ocupação nova e mudança de status (FOR SHARE) depende de READ
   COMMITTED, que `withTenant` fixa. Jobs ou SQL manual fora de `withTenant` também rodam em
   READ COMMITTED.

   **Fila por profissional** (migração `0004`): o EXCLUDE grava no índice antes de procurar
   conflito, então duas reservas simultâneas que se sobrepõem podiam esperar uma pela outra e
   terminar em deadlock (40P01) em vez de 23P01. O trigger `occupancies_lock_staff_schedule`
   pega `pg_advisory_xact_lock` pelo hash do `staff_id` antes de gravar ocupação ativa
   (INSERT ou reativação): a 2ª reserva do mesmo profissional espera a 1ª terminar e recebe
   23P01 na hora. Outro profissional e outro tenant não esperam. A fila vale para a agenda
   inteira do profissional e dura até o fim da transação: grave as ocupações por último e
   mantenha a transação curta. Reserva com profissionais diferentes pega um lock por
   profissional, na ordem dos INSERTs: duas reservas em ordem inversa podem dar deadlock mesmo
   sem sobreposição de horário (`withTenant` repete a vítima). Grave as ocupações em ordem de
   `staff_id`.
4. **Invariantes no deploy.** `app_private.assert_security_invariants()` roda ao fim de **toda**
   execução do runner, que antes confere o hash do corpo dela (`INVARIANTS_FUNCTION_SHA256` em
   `src/migrate.ts`) e falha se ela sumir, for renomeada ou esvaziada. Nada é commitado se, em
   qualquer schema de usuário:
   - tabela com `tenant_id` (ou `app.tenants`) estiver sem RLS, sem FORCE ou sem a política
     RESTRICTIVE **canônica** (FOR ALL, TO PUBLIC, `tenant_id = app.tenant_id` no USING e no
     WITH CHECK);
   - algum papel `app_*` for SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB ou REPLICATION, for
     membro de outro papel, ou `app_migrator` tiver LOGIN/INHERIT;
   - algo em `app`/`app_private` (relação, função, tipo, schema) não for do `app_migrator`, ou
     algo em qualquer schema de usuário for de um papel de runtime;
   - houver privilégio de PUBLIC em tabela, privilégio de runtime fora de
     SELECT/INSERT/UPDATE/DELETE (inclusive de coluna), INSERT/DELETE ou UPDATE de tabela
     inteira para `app_worker`, escrita da aplicação na auditoria, DELETE de agendamento, ou
     DELETE/UPDATE (fora de `active`) em `occupancies` para a aplicação;
   - houver função SECURITY DEFINER sem `search_path` fixo terminado em `pg_temp`, ou
     executável por PUBLIC ou pela aplicação fora da lista explícita `executable_definers`
     (hoje vazia);
   - houver view sem `security_invoker`, materialized view ou foreign table legível pela
     aplicação (não aceitam RLS), USAGE/CREATE de PUBLIC em `app`/`app_private`, CREATE de
     runtime em schema ou no banco, ou USAGE de runtime em `app_private`;
   - faltar (ou estiver desabilitado) um trigger crítico (máquina de estados, fuso, ocupação,
     completude, auditoria append-only) ou um EXCLUDE anti-sobreposição, ou um desses triggers
     tiver definição diferente da esperada: momento, eventos (com as colunas do `UPDATE OF`),
     adiamento até o COMMIT, nível, `WHEN` e função, lidos de `pg_trigger` (recriar a
     completude do item como `AFTER UPDATE`, por exemplo, é recusado).

   O portão pega erro honesto e drift (mudança manual no banco). Não pega migração maliciosa:
   quem migra é dono de tudo; para isso valem a revisão e os meta-testes do `pnpm test:db`.

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
| `0004_staff_schedule_lock` | `app_migrator` | fila por profissional ao gravar ocupação ativa (sem deadlock no EXCLUDE) |

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
| `pnpm --filter @salon/db test` | unidade, sem banco: erros, ids, validação de `withTenant`, runner, **drift** entre schema e migrações, paridade com o core (trigger da máquina de estados e tipos de ocupação do CHECK `occupancies_kind_valid`) e o meta-teste de higiene da suíte (`test/test-hygiene.test.ts`) |
| `pnpm test:db` (raiz) ou `pnpm --filter @salon/db test:db` | integração e RLS no PostgreSQL real |

`test:db` usa `TEST_DATABASE_URL` (superusuário de um cluster **de teste**). Sem ela,
`scripts/with-local-postgres.sh` sobe um PostgreSQL efêmero com os binários locais. O global
setup cria um banco descartável, aplica as migrações com o runner de produção, define senhas
aleatórias para `app_user`/`app_worker` e apaga o banco ao final. Os arquivos rodam em série
(`pool: 'forks'`, `fileParallelism: false`).

Os dois projetos rodam em **ordem aleatória** (arquivos e testes), com `.only` proibido também
fora do CI (`allowOnly: false`) e sem nova tentativa (`retry: 0`). A integração pode embaralhar
porque cada arquivo cria os próprios tenants e cada teste usa dia ou horário próprio. A semente
sai no cabeçalho ("Running tests with seed"); para reproduzir uma falha, rode de novo com
`--sequence.seed=<semente>`. O meta-teste de higiene fixa essa config, garante que todo arquivo
de teste roda em exatamente um projeto e recusa teste focado, pulado, pendente ou dica de
exclusão de cobertura em `src/` e `test/`. Além do texto, o reporter compartilhado
`test-support/vitest-no-disabled-tests-reporter.ts` (o mesmo do core e do web, nos dois
projetos) reprova pelo RESULTADO: a execução sai com 1 se algum teste terminar pulado,
pendente ou com falha esperada, qualquer que seja a sintaxe.

Cobertura de integração:

- isolamento em todas as tabelas: leitura, UPDATE, DELETE, INSERT com tenant alheio, UPDATE
  trocando `tenant_id`, sem contexto, FK cruzada, PK global e `app_worker` (só status);
- regressão `'' -> 22P02` do GUC na mesma conexão;
- `tx` que escapa do callback (builder devolvido, `Promise.all` com ramo que falha) não lê
  nem grava na transação de outro tenant; READ COMMITTED fixo mesmo com outro padrão na sessão
  (a janela entre o callback e o COMMIT e o descarte da conexão sem desfecho limpo ficam nos
  testes de unidade, com um cliente falso);
- ocupação amarrada ao item (profissional, janela com buffers, imutável, sem DELETE) e
  completude no COMMIT (cada fase `work` coberta por ocupação `service`, não `buffer`; itens
  dentro da visita; item novo numa visita já confirmada, em outra transação); visita (unidade,
  fuso, horário) e item (profissional, horário, fases, buffers) imutáveis, coluna a coluna;
  instantes de transição, hold e `created_at` gravados pelo banco; hora repetida do fim do
  horário de verão distinguida pelo offset;
- EXCLUDE: sobreposição, intervalos encostados, cancelado/no-show liberando, reativação
  colidindo e corrida controlada e real (exatamente uma vence);
- fila por profissional: a 2ª reserva (e a reativação) espera a 1ª no advisory lock, mesmo em
  outro horário; outro profissional e outro tenant não esperam; deadlock clássico entre duas
  transações é repetido pelo `withTenant` e as duas concluem;
- os 81 pares da máquina de estados;
- paridade com o core no banco migrado: todo fuso aceito pelo banco é aceito pelo core; uma
  amostra fixa (os 16 fusos do Brasil, `Etc/UTC` e os fusos dos testes do core) passa nos dois
  lados; os fusos recusados do exemplo (dígitos, `Etc/GMT±N`, `UTC`) também são recusados
  pelo core (aliases legados como `US/Eastern` passam no core e são recusados por um
  PostgreSQL sem tzdata-legacy: falha fechada no CHECK); e o CHECK
  `occupancies_kind_valid` aceita exatamente `OCCUPANCY_KINDS`;
- auditoria append-only e meta-testes de catálogo, inclusive sabotagens que a função de
  invariantes precisa detectar (política neutralizada, SECURITY DEFINER em schema novo, posse,
  ACL de schema, trigger e EXCLUDE removidos, trigger recriado com outro evento, sem adiar,
  com `WHEN` ou com outra função, dono com LOGIN);
- runner: idempotência, lock concorrente, imutabilidade, rollback, função de invariantes
  apagada/renomeada/esvaziada e `app_migrator` reaproveitado com LOGIN.

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
- O bootstrap revoga o CREATE de PUBLIC no schema `public`. Se o admin não for dono do schema,
  o REVOKE só avisa e a função de invariantes recusa o deploy enquanto um papel de runtime
  puder criar objetos ali: rode o REVOKE como dono do banco.
- Ainda não implementado (próximas iterações): tabelas do Better Auth (schema `auth`, papel
  `app_auth`); resolução pública `slug -> tenant` para a página de agendamento (função
  `SECURITY DEFINER` dedicada, já que `tenants` só é visível ao próprio tenant: entra em
  `executable_definers` da função de invariantes, com `search_path` fixo, dona do
  `app_migrator` e fechada a PUBLIC); job de expiração de holds e de no-show (pg-boss, papel
  `app_worker`, já coberto pelo GRANT de `status`); recálculo de `starts_at` quando o tzdata
  muda (precisa de caminho privilegiado: item e ocupação são imutáveis para a aplicação);
  procedimento privilegiado de exclusão de tenant e retenção (LGPD), lembrando que
  `appointment_events` bloqueia DELETE. Job que precise escrever outra coluna ganha GRANT de
  coluna explícito numa migração nova.
