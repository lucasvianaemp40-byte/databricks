# ADR-0002: Isolamento multi-tenant com PostgreSQL RLS

- **Status:** Aceito
- **Data:** 2026-10-17
- **Relacionados:** [arquitetura, seção 5](../arquitetura.md#5-multi-tenancy-em-profundidade),
  [packages/db/README.md](../../packages/db/README.md), [modelo de ameaças](../seguranca/modelo-de-ameacas.md)

## Contexto

Cada salão é um tenant. Um salão ver dados de outro (clientes, telefones, agenda) é o pior
incidente possível do produto: viola a LGPD e quebra a confiança. Requisito ASVS 5.0 **8.4.1**
(nível 2): controles cross-tenant em aplicação multi-tenant.

Fatos verificados na documentação do PostgreSQL ("Row Security Policies", `CREATE POLICY`,
`set_config`) e em testes no PostgreSQL 16.15:

- Sem política, a RLS nega tudo (default-deny). Superusuário e papel com `BYPASSRLS` sempre
  ignoram a RLS. O **dono da tabela** também ignora, a menos que haja
  `ALTER TABLE ... FORCE ROW LEVEL SECURITY`.
- **Checagens de FK, UNIQUE e PK ignoram a RLS.** FK simples permite referenciar linha de
  outro tenant, e `UNIQUE(phone)` global revela que um telefone existe em outro tenant (canal
  encoberto).
- `TRUNCATE` e `REFERENCES` não passam pela RLS.
- `set_config(nome, valor, true)` vale só até o fim da transação. Isso é compatível com
  PgBouncer em modo transação, o que `SET` de sessão não é.
- Depois de uma transação que fez `set_config(..., true)`, a mesma conexão devolve `''` (e
  não `NULL`) em `current_setting('app.tenant_id', true)`. Uma política com `::uuid` direto
  falha com `22P02`.
- Políticas RESTRICTIVE precisam passar todas, e só com elas nada fica visível. O padrão é
  "guarda RESTRICTIVE de tenant + PERMISSIVE por papel".
- Views rodam com as permissões do dono, a menos que tenham `security_invoker = true`.
- O `drizzle-kit` gera `ENABLE ROW LEVEL SECURITY`, mas não `FORCE`. `EXCLUDE` e triggers
  vão em migração custom.

## Decisão

**Tabelas compartilhadas com `tenant_id` e RLS como segunda camada**, abaixo da autorização
da aplicação.

1. **Contexto por transação:** `withTenant(db, tenantId, fn, { actor })` é a única porta para
   dado de tenant. Valida o UUID, abre a transação em READ COMMITTED (fixo, vence o padrão do
   banco, do papel ou da URL) e faz `set_config('app.tenant_id', id, true)`, fixando também
   `TimeZone=UTC` e o ator da auditoria. O `tenantId` vem só da sessão no servidor. O `tx` só
   vale enquanto `fn` executa: `withTenant` embrulha a conexão, e depois do callback só passam
   COMMIT e ROLLBACK; qualquer outra consulta é recusada com `TransactionClosedError` sem tocar
   no banco, e a conexão com transação sem desfecho limpo, com consulta ainda em voo ou que
   emitiu erro é destruída em vez de voltar ao pool. Enquanto emprestada, a conexão tem um
   ouvinte de `error`, para que uma queda no meio do callback falhe a transação em vez de
   derrubar o processo.
2. **RLS `ENABLE` + `FORCE`** em toda tabela com `tenant_id` e em `tenants`:
   - `tenant_isolation`: `AS RESTRICTIVE FOR ALL TO PUBLIC`, com
     `tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid)`. O
     `SELECT` em volta vira InitPlan, avaliado uma vez por consulta.
   - `app_access`: `AS PERMISSIVE` para `app_user` e `app_worker`.
3. **Papéis:**
   - `app_migrator` é `NOLOGIN` e dono de tudo. O runner assume esse papel com
     `SET LOCAL ROLE`.
   - `app_user` (web) e `app_worker` (jobs) são `LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`,
     não são donos e não têm `TRUNCATE`, `REFERENCES` nem `TRIGGER`.
   - O `app_worker` lê o tenant do job e só tem UPDATE de duas colunas, por GRANT de coluna:
     `appointments.status` e `occupancies.active` (que um trigger recalcula a partir do status).
     Não tem INSERT, DELETE nem UPDATE de tabela inteira. Job novo que precise escrever outra
     coluna ganha GRANT de coluna explícito numa migração nova e o ajuste correspondente em
     `assert_security_invariants()`, que hoje recusa qualquer outro privilégio de escrita do
     worker.
   - Nenhuma senha fica no repositório.
4. **Integridade cross-tenant:** FKs compostas `(tenant_id, x_id) → (tenant_id, id)` e toda
   UNIQUE de negócio e todo EXCLUDE começando por `tenant_id`. Exceção consciente: a PK `id` é
   global. Um `id` que já existe em outro tenant devolve 23505 mesmo com a RLS escondendo a
   linha; isso não vaza nada porque o id nasce no servidor (UUIDv7) e nunca muda, e o
   `@salon/db` traduz o erro para `IdentifierConflictError`, respondido como 404/409 genérico.
   A PK não vira `(tenant_id, id)` para que um id nunca se repita entre salões.
5. **Invariantes no deploy:** `app_private.assert_security_invariants()` roda ao fim de toda
   execução do runner, que antes confere o hash do corpo dela e falha se ela sumir, for
   renomeada ou esvaziada. Nada é commitado se, em qualquer schema de usuário (escopo completo
   em [packages/db/README.md](../../packages/db/README.md#segurança-multi-tenant-defesa-em-profundidade),
   item 4):
   - tabela com `tenant_id` (ou `app.tenants`) estiver sem RLS, sem `FORCE` ou sem a política
     RESTRICTIVE **canônica** (FOR ALL, TO PUBLIC, mesma expressão no USING e no WITH CHECK);
   - papel `app_*` tiver `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB` ou `REPLICATION`,
     for membro de outro papel, ou `app_migrator` tiver LOGIN ou INHERIT;
   - objeto (relação, função, tipo ou schema) não pertencer a `app_migrator`;
   - houver privilégio de PUBLIC em tabela, privilégio de runtime fora de SELECT, INSERT,
     UPDATE e DELETE, escrita do `app_worker` além do GRANT de coluna, escrita da aplicação na
     auditoria, DELETE de agendamento ou DELETE/UPDATE (fora de `active`) de ocupação;
   - função `SECURITY DEFINER` estiver sem `search_path` fixo terminado em `pg_temp` ou for
     executável por PUBLIC ou pela aplicação fora da lista `executable_definers` (hoje vazia);
   - view estiver sem `security_invoker`, ou houver materialized view ou foreign table legível
     pela aplicação;
   - PUBLIC tiver USAGE ou CREATE em `app`/`app_private`, ou um papel de runtime tiver CREATE
     em schema ou no banco;
   - faltar ou estiver desligado um trigger crítico ou um EXCLUDE anti-sobreposição, ou um
     trigger crítico for recriado com definição diferente da esperada, lida de `pg_trigger`:
     constraint trigger ou não, momento, eventos e colunas do `UPDATE OF`, adiamento até o
     COMMIT, nível, presença de `WHEN`, número de argumentos e função (recriar a completude do
     item como `AFTER UPDATE`, por exemplo, é recusado). Essa comparação só foi validada no
     PostgreSQL 16.15; se o 18 do CI divergir, o `pnpm test:db` falha fechado.

   O portão pega erro honesto e drift (mudança manual no banco). Não pega migração maliciosa:
   quem migra é dono de tudo. Para isso valem a revisão de migração e os meta-testes do
   `pnpm test:db`.
6. **Auditoria append-only:** `appointment_events` é escrita só por trigger
   `SECURITY DEFINER`. A aplicação só lê, e UPDATE, DELETE e TRUNCATE falham até para o dono.
7. **Respostas:** recurso de outro tenant responde 404, e `TenantIsolationError` (`42501`)
   vira 404 na borda.

## Consequências

- **Positivas:**
  - um bug de autorização na aplicação não basta para vazar dados entre salões;
  - o deploy falha se a segurança do banco regredir;
  - os testes provam o isolamento contra PostgreSQL real, com papéis reais (`pnpm test:db`).
- **O que a RLS cobre e o que não cobre:**
  - cobre o filtro esquecido (`SELECT` sem `WHERE tenant_id`) e o id de outro tenant vindo da
    requisição: a linha não aparece, e INSERT ou UPDATE com tenant alheio falham;
  - **não** cobre o tenant errado posto no contexto: se o servidor passar a `withTenant` o
    tenant de outra pessoa, a RLS obedece. Por isso o `tenantId` sai só da sessão, depois da
    membership verificada (DAL);
  - **não** cobre um `tx` usado depois do callback: a consulta atrasada rodaria na transação
    de outra requisição, com o tenant dela, e a RLS não teria como perceber. Quem bloqueia
    isso é a guarda de `withTenant` (`TransactionClosedError`), não a RLS.
- **Negativas e riscos:**
  - **Qualquer sessão pode chamar `set_config`.** Uma injeção de SQL troca de tenant.
    Mitigação: SQL parametrizado, `sql.raw` só com constantes (regra Semgrep
    `sql-raw-interpolation`) e o DAL como primeira camada. Opção futura (ASVS nível 3):
    assinar o contexto com HMAC validado por função `SECURITY DEFINER`.
  - Manutenção cross-tenant (retenção LGPD, exclusão de tenant, varredura de holds sem
    tenant) precisa de procedimento privilegiado dedicado, nunca de conexão privilegiada no
    caminho de requisição.
  - Sem contexto, nem o superusuário consegue mudar status: o trigger de auditoria é barrado
    pela RLS. Manutenção precisa definir `app.tenant_id`.
  - Consultas sempre dentro de transação. O custo é pequeno com pool.
  - A página pública (anônima) precisa de uma função dedicada para `slug → tenant`, porque
    `tenants` só é visível ao próprio tenant.
- **Ações decorrentes:**
  - checklist de tabela nova no [README do db](../../packages/db/README.md#migrações) e na
    skill `review-migration`;
  - rodar os meta-testes de catálogo também contra staging e produção com o papel real,
    porque o perigo é a configuração implantada.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Só filtro na aplicação (`WHERE tenant_id = ?`) | Um esquecimento vaza dados. Sem defesa em profundidade |
| Schema por tenant | Migrações N vezes, pool por schema, custo operacional alto para milhares de salões MEI |
| Banco por tenant | Custo e operação inviáveis para o perfil de cliente (94% dos novos negócios de beleza são MEI, segundo o Sebrae) |
| RLS com `auth.uid()` (Supabase) | Acopla à plataforma Supabase. Nosso tenant é a organização, não o usuário |
| `SET` de sessão em vez de `set_config(..., true)` | Vaza contexto entre requisições com pooler em modo transação |
| `UNIQUE (..., WITHOUT OVERLAPS)` (PG 18) no lugar de `EXCLUDE` | Não aceita o `WHERE` de ocupação ativa, e o schema precisa rodar no PG 16 |

## Referências

- PostgreSQL, "Row Security Policies" (`doc/src/sgml/ddl.sgml`) e `CREATE POLICY`:
  https://github.com/postgres/postgres/tree/REL_18_STABLE/doc/src/sgml
- OWASP Multi-Tenant Security Cheat Sheet:
  https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.md
- OWASP ASVS 5.0.0, requisito 8.4.1: https://github.com/OWASP/ASVS/tree/v5.0.0_release/5.0
- Implementação: [`packages/db/drizzle/0003_tenant_security.sql`](../../packages/db/drizzle/0003_tenant_security.sql)
