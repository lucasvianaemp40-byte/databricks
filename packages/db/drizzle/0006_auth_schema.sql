-- =============================================================================
-- 0006 · Schema auth do Better Auth (ADR-0004) e invariantes que cobrem o app_auth.
-- Roda como app_migrator, que fica dono do schema e das tabelas.
--
-- Tabelas: as do Better Auth 1.7 com o plugin organization, nos nomes e tipos que ele espera
-- (colunas em camelCase, ids uuid com `advanced.database.generateId: "uuid"`). Foram geradas
-- pelo `getMigrations` do próprio Better Auth contra um banco vazio; o teste de drift do
-- @salon/web (`pnpm test:db`) confere que o Better Auth não vê nada a criar ou alterar.
--
-- Isolamento: só o app_auth lê e grava aqui (hash de senha, tokens de sessão). O app_user e o
-- app_worker não têm nem USAGE no schema; o app_auth não tem nada em app/app_private. A
-- organização do Better Auth é o tenant: `auth.organization.id` = `app.tenants.id` (sem FK
-- entre schemas: a criação do salão grava os dois, e o DAL confere o membro a cada acesso).
--
-- Invariantes (CREATE OR REPLACE da função da 0003): app_auth entra nas listas de papéis
-- (atributos, herança, posse e privilégios), o schema auth entra na regra de posse, e dois
-- privilégios novos são recusados: papel de runtime (exceto app_auth) no schema auth, e
-- app_auth fora dele. O hash do corpo (INVARIANTS_FUNCTION_SHA256 em src/migrate.ts) muda
-- junto.
-- =============================================================================

CREATE SCHEMA auth;
--> statement-breakpoint
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA auth TO app_auth;
--> statement-breakpoint
CREATE TABLE auth."user" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE auth."session" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "activeOrganizationId" text
);
--> statement-breakpoint
CREATE TABLE auth."account" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE auth."verification" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE auth."organization" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "logo" text,
  "createdAt" timestamptz NOT NULL,
  "metadata" text
);
--> statement-breakpoint
CREATE TABLE auth."member" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "organizationId" uuid NOT NULL REFERENCES auth."organization" ("id") ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "createdAt" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE auth."invitation" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "organizationId" uuid NOT NULL REFERENCES auth."organization" ("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text,
  "status" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "inviterId" uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON auth."session" ("userId");
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON auth."account" ("userId");
--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON auth."verification" ("identifier");
--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON auth."member" ("organizationId");
--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON auth."member" ("userId");
--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON auth."invitation" ("organizationId");
--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON auth."invitation" ("email");
--> statement-breakpoint
-- Um membro por (organização, usuário): o Better Auth confere antes de inserir, e o banco
-- garante sob concorrência (dois cliques em "criar salão" ou no aceite de convite).
CREATE UNIQUE INDEX "member_organizationId_userId_key" ON auth."member" ("organizationId", "userId");
--> statement-breakpoint
-- Uma conta por (provedor, id no provedor): duas vinculações simultâneas não duplicam. Feito
-- com a tabela vazia, porque o runner não aceita CONCURRENTLY.
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON auth."account" ("providerId", "accountId");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO app_auth;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_private.assert_security_invariants()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  runtime_roles constant text[] := ARRAY['app_user', 'app_worker', 'app_auth'];
  app_roles constant text[] := ARRAY['app_migrator', 'app_user', 'app_worker', 'app_auth'];
  allowed_privileges constant text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
  -- Funções SECURITY DEFINER que a aplicação PODE executar (regprocedure como texto). Hoje,
  -- nenhuma. A resolução pública slug -> tenant entra aqui, numa migração revisada.
  executable_definers constant text[] := ARRAY[]::text[];
  -- Política de tenant canônica, comparada sem espaços, sem casts ::text e sem o alias da
  -- subconsulta (o deparse só varia nesses detalhes entre versões do PostgreSQL).
  tenant_guard constant text :=
    '(tenant_id=(SELECT(NULLIF(current_setting(''app.tenant_id'',true),''''))::uuid))';
  tenants_guard constant text :=
    '(id=(SELECT(NULLIF(current_setting(''app.tenant_id'',true),''''))::uuid))';
  -- Triggers que sustentam isolamento, auditoria e anti-overbooking, com a definição esperada
  -- montada do catálogo em (i): momento, eventos (colunas do UPDATE OF em ordem alfabética),
  -- adiamento, nível e função. Campos de pg_trigger, estáveis entre versões do PostgreSQL.
  required_triggers constant text[][] := ARRAY[
    ['app.appointments', 'appointments_guard_status',
     'BEFORE INSERT OR UPDATE FOR EACH ROW EXECUTE FUNCTION app_private.appointments_guard_status()'],
    ['app.appointments', 'appointments_guard_location_timezone',
     'BEFORE INSERT FOR EACH ROW EXECUTE FUNCTION app_private.appointments_guard_location_timezone()'],
    ['app.appointments', 'appointments_sync_occupancies',
     'AFTER UPDATE OF status FOR EACH ROW EXECUTE FUNCTION app_private.appointments_sync_occupancies()'],
    ['app.appointments', 'appointments_write_event',
     'AFTER INSERT OR UPDATE OF status FOR EACH ROW EXECUTE FUNCTION app_private.appointments_write_event()'],
    ['app.appointments', 'appointments_occupancy_required',
     'CONSTRAINT AFTER INSERT OR UPDATE OF status DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
       'EXECUTE FUNCTION app_private.appointments_assert_occupancy()'],
    ['app.appointment_items', 'appointment_items_guard_schedule',
     'BEFORE UPDATE OR DELETE FOR EACH ROW EXECUTE FUNCTION app_private.appointment_items_guard_schedule()'],
    ['app.appointment_items', 'appointment_items_occupancy_required',
     'CONSTRAINT AFTER INSERT DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
       'EXECUTE FUNCTION app_private.appointments_assert_occupancy()'],
    ['app.occupancies', 'occupancies_derive_active',
     'BEFORE INSERT OR UPDATE FOR EACH ROW EXECUTE FUNCTION app_private.occupancies_derive_active()'],
    ['app.occupancies', 'occupancies_guard_within_item',
     'BEFORE INSERT OR UPDATE OF appointment_id, appointment_item_id, ends_at, kind, staff_id, '
       'starts_at FOR EACH ROW EXECUTE FUNCTION app_private.occupancies_guard_within_item()'],
    ['app.appointment_events', 'appointment_events_append_only',
     'BEFORE UPDATE OR DELETE FOR EACH ROW EXECUTE FUNCTION app_private.reject_append_only_mutation()'],
    ['app.appointment_events', 'appointment_events_no_truncate',
     'BEFORE TRUNCATE FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_mutation()']
  ];
  required_exclusions constant text[][] := ARRAY[
    ['app.occupancies', 'occupancies_no_staff_overlap'],
    ['app.working_hours', 'working_hours_no_overlap']
  ];
  problems text[] := ARRAY[]::text[];
  r record;
  i integer;
BEGIN
  -- (a) Toda tabela com tenant_id (em qualquer schema de usuário) e app.tenants: RLS
  --     habilitada, FORÇADA e com a política RESTRICTIVE canônica: FOR ALL, TO PUBLIC, USING
  --     e WITH CHECK iguais a `tenant_id = NULLIF(current_setting('app.tenant_id', true),
  --     '')::uuid` (`id` em app.tenants). Política para um papel só, FOR SELECT ou USING
  --     (true) não conta.
  FOR r IN
    SELECT c.oid::regclass AS rel, c.relrowsecurity, c.relforcerowsecurity,
           EXISTS (
             SELECT FROM pg_policy p
              CROSS JOIN LATERAL (
                SELECT regexp_replace(regexp_replace(regexp_replace(
                         pg_get_expr(p.polqual, p.polrelid), '::text', '', 'g'),
                         '\s', '', 'g'), 'AS"[^"]*"', '', 'g') AS qual,
                       regexp_replace(regexp_replace(regexp_replace(
                         pg_get_expr(p.polwithcheck, p.polrelid), '::text', '', 'g'),
                         '\s', '', 'g'), 'AS"[^"]*"', '', 'g') AS with_check
              ) AS e
              WHERE p.polrelid = c.oid
                AND NOT p.polpermissive
                AND p.polcmd = '*'
                AND p.polroles = '{0}'::oid[]
                AND e.qual = e.with_check
                AND e.qual = CASE WHEN n.nspname = 'app' AND c.relname = 'tenants'
                                  THEN tenants_guard ELSE tenant_guard END
           ) AS has_tenant_guard
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\_%'
       AND (EXISTS (SELECT FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                       AND a.attnum > 0 AND NOT a.attisdropped)
            OR (n.nspname = 'app' AND c.relname = 'tenants'))
  LOOP
    IF NOT r.relrowsecurity THEN
      problems := problems || format('%s: RLS desabilitada', r.rel);
    END IF;
    IF NOT r.relforcerowsecurity THEN
      problems := problems || format('%s: RLS sem FORCE', r.rel);
    END IF;
    IF NOT r.has_tenant_guard THEN
      problems := problems || format(
        '%s: sem política RESTRICTIVE de tenant canônica (FOR ALL, TO PUBLIC, app.tenant_id)', r.rel);
    END IF;
  END LOOP;

  -- (b) Atributos dos papéis: ninguém é SUPERUSER/BYPASSRLS (FORCE RLS não vale para eles) nem
  --     tem CREATEROLE/CREATEDB/REPLICATION; o dono (app_migrator) é NOLOGIN e NOINHERIT: só
  --     se chega a ele por SET ROLE no deploy.
  FOR r IN
    SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
           rolcanlogin, rolinherit
      FROM pg_roles
     WHERE rolname = ANY (app_roles)
  LOOP
    IF r.rolsuper OR r.rolbypassrls THEN
      problems := problems || format('papel %s é SUPERUSER ou BYPASSRLS', r.rolname);
    END IF;
    IF r.rolcreaterole OR r.rolcreatedb OR r.rolreplication THEN
      problems := problems || format('papel %s tem CREATEROLE, CREATEDB ou REPLICATION', r.rolname);
    END IF;
    IF r.rolname = 'app_migrator' AND (r.rolcanlogin OR r.rolinherit) THEN
      problems := problems || 'papel app_migrator precisa ser NOLOGIN e NOINHERIT';
    END IF;
  END LOOP;

  -- (c) Os papéis da aplicação (inclusive o dono) não herdam nada: não são membros de nenhum papel.
  FOR r IN
    SELECT u.rolname AS member, g.rolname AS granted
      FROM pg_auth_members m
      JOIN pg_roles u ON u.oid = m.member
      JOIN pg_roles g ON g.oid = m.roleid
     WHERE u.rolname = ANY (app_roles)
  LOOP
    problems := problems || format('papel %s é membro de %s', r.member, r.granted);
  END LOOP;

  -- (d) Posse: tudo em app/app_private/auth (relações, funções, tipos e os schemas) pertence ao
  --     app_migrator, que é sujeito a FORCE RLS. Os construtores de um tipo range pertencem ao
  --     superusuário de bootstrap (dependência interna do tipo) e ficam de fora. Papéis de
  --     runtime não são donos de nada em schema de usuário (tabela temporária da sessão, em
  --     pg_temp_N, não conta).
  FOR r IN
    SELECT o.label, o.owner
      FROM (
        SELECT c.oid::regclass::text AS label, pg_get_userbyid(c.relowner) AS owner,
               n.nspname AS nspname
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        UNION ALL
        SELECT 'função ' || p.oid::regprocedure::text, pg_get_userbyid(p.proowner), n.nspname
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE NOT EXISTS (SELECT FROM pg_depend d
                            WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                              AND d.refclassid = 'pg_type'::regclass AND d.deptype = 'i')
        UNION ALL
        SELECT 'tipo ' || t.oid::regtype::text, pg_get_userbyid(t.typowner), n.nspname
          FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        UNION ALL
        SELECT 'schema ' || n.nspname, pg_get_userbyid(n.nspowner), n.nspname
          FROM pg_namespace n
      ) AS o
     WHERE (o.nspname IN ('app', 'app_private', 'auth') AND o.owner <> 'app_migrator')
        OR (o.owner = ANY (runtime_roles)
            AND o.nspname NOT IN ('pg_catalog', 'information_schema')
            AND o.nspname NOT LIKE 'pg\_%')
  LOOP
    problems := problems || format('%s pertence a %s (esperado app_migrator)', r.label, r.owner);
  END LOOP;

  -- (e) Privilégios de tabela/coluna em qualquer schema de usuário: PUBLIC nada; runtime só
  --     SELECT/INSERT/UPDATE/DELETE. app_worker não insere nem apaga e altera só por GRANT de
  --     coluna (nunca UPDATE na tabela inteira); a aplicação só lê a auditoria, não apaga
  --     agendamento e não apaga nem move ocupação (UPDATE só de `active`). Credenciais (schema
  --     auth) só para o app_auth, e o app_auth só no schema auth.
  FOR r IN
    WITH relations AS (
      SELECT c.oid, c.oid::regclass AS rel, c.relacl, n.nspname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg\_%'
         AND NOT EXISTS (SELECT FROM pg_depend d
                          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                            AND d.deptype = 'e')
    )
    SELECT rel, acl.grantee, acl.privilege_type AS privilege
      FROM relations CROSS JOIN LATERAL aclexplode(relacl) AS acl
     WHERE acl.grantee = 0
        OR (pg_get_userbyid(acl.grantee) = ANY (runtime_roles)
            AND acl.privilege_type <> ALL (allowed_privileges))
    UNION ALL
    SELECT rel, acl.grantee, acl.privilege_type || ' (coluna ' || a.attname || ')'
      FROM relations
      JOIN pg_attribute a ON a.attrelid = relations.oid AND a.attnum > 0 AND NOT a.attisdropped
     CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
     WHERE acl.grantee = 0
        OR (pg_get_userbyid(acl.grantee) = ANY (runtime_roles)
            AND acl.privilege_type <> ALL (allowed_privileges))
    UNION ALL
    SELECT rel, acl.grantee, 'UPDATE na tabela inteira (use GRANT por coluna)'
      FROM relations CROSS JOIN LATERAL aclexplode(relacl) AS acl
     WHERE pg_get_userbyid(acl.grantee) = 'app_worker' AND acl.privilege_type = 'UPDATE'
    UNION ALL
    SELECT rel, acl.grantee, acl.privilege_type || ' (app_worker só lê e altera status)'
      FROM relations CROSS JOIN LATERAL aclexplode(relacl) AS acl
     WHERE pg_get_userbyid(acl.grantee) = 'app_worker' AND acl.privilege_type IN ('INSERT', 'DELETE')
    UNION ALL
    SELECT rel, acl.grantee, acl.privilege_type || ' (auditoria: a aplicação só lê)'
      FROM relations CROSS JOIN LATERAL aclexplode(relacl) AS acl
     WHERE relations.oid = to_regclass('app.appointment_events')
       AND pg_get_userbyid(acl.grantee) = ANY (runtime_roles)
       AND acl.privilege_type <> 'SELECT'
    UNION ALL
    SELECT rel, acl.grantee, acl.privilege_type || ' (agendamento se cancela pelo status)'
      FROM relations CROSS JOIN LATERAL aclexplode(relacl) AS acl
     WHERE relations.oid = to_regclass('app.appointments')
       AND pg_get_userbyid(acl.grantee) = ANY (runtime_roles)
       AND acl.privilege_type = 'DELETE'
    UNION ALL
    SELECT rel, acl.grantee, acl.privilege_type || ' (ocupação não se apaga nem se move)'
      FROM relations CROSS JOIN LATERAL aclexplode(relacl) AS acl
     WHERE relations.oid = to_regclass('app.occupancies')
       AND pg_get_userbyid(acl.grantee) = ANY (runtime_roles)
       AND acl.privilege_type IN ('UPDATE', 'DELETE')
    UNION ALL
    SELECT rel, acl.grantee, acl.privilege_type || ' (coluna ' || a.attname || '; só active)'
      FROM relations
      JOIN pg_attribute a ON a.attrelid = relations.oid AND a.attnum > 0 AND NOT a.attisdropped
     CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
     WHERE relations.oid = to_regclass('app.occupancies')
       AND pg_get_userbyid(acl.grantee) = ANY (runtime_roles)
       AND acl.privilege_type = 'UPDATE' AND a.attname <> 'active'
    UNION ALL
    SELECT rel, acl.grantee, acl.privilege_type || ' (app_auth: só o schema auth)'
      FROM relations CROSS JOIN LATERAL aclexplode(relacl) AS acl
     WHERE relations.nspname <> 'auth' AND pg_get_userbyid(acl.grantee) = 'app_auth'
    UNION ALL
    SELECT rel, acl.grantee,
           acl.privilege_type || ' (coluna ' || a.attname || '; app_auth: só o schema auth)'
      FROM relations
      JOIN pg_attribute a ON a.attrelid = relations.oid AND a.attnum > 0 AND NOT a.attisdropped
     CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
     WHERE relations.nspname <> 'auth' AND pg_get_userbyid(acl.grantee) = 'app_auth'
    UNION ALL
    SELECT rel, acl.grantee, acl.privilege_type || ' (credenciais: só app_auth)'
      FROM relations CROSS JOIN LATERAL aclexplode(relacl) AS acl
     WHERE relations.nspname = 'auth'
       AND pg_get_userbyid(acl.grantee) = ANY (runtime_roles)
       AND pg_get_userbyid(acl.grantee) <> 'app_auth'
    UNION ALL
    SELECT rel, acl.grantee,
           acl.privilege_type || ' (coluna ' || a.attname || '; credenciais: só app_auth)'
      FROM relations
      JOIN pg_attribute a ON a.attrelid = relations.oid AND a.attnum > 0 AND NOT a.attisdropped
     CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
     WHERE relations.nspname = 'auth'
       AND pg_get_userbyid(acl.grantee) = ANY (runtime_roles)
       AND pg_get_userbyid(acl.grantee) <> 'app_auth'
  LOOP
    problems := problems || format('%s: privilégio %s concedido a %s', r.rel, r.privilege,
      CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r.grantee) END);
  END LOOP;

  -- (f) SECURITY DEFINER em qualquer schema de usuário (fora de extensões): toda função fixa o
  --     search_path terminando em pg_temp (senão um objeto temporário homônimo seria achado
  --     antes), e nenhuma é executável por PUBLIC ou pelos papéis de runtime, exceto as da
  --     lista `executable_definers` (donas do app_migrator e nunca abertas a PUBLIC).
  FOR r IN
    SELECT p.oid::regprocedure::text AS fn,
           pg_get_userbyid(p.proowner) AS owner,
           EXISTS (SELECT FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg
                    WHERE cfg ~ '^search_path=.*\mpg_temp"?$') AS fixed_search_path,
           has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute,
           ARRAY(SELECT role_name FROM unnest(runtime_roles) AS role_name
                  WHERE has_function_privilege(role_name, p.oid, 'EXECUTE')) AS executors
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\_%'
       AND NOT EXISTS (SELECT FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                          AND d.deptype = 'e')
  LOOP
    IF NOT r.fixed_search_path THEN
      problems := problems || format(
        '%s (SECURITY DEFINER) sem search_path fixo terminado em pg_temp', r.fn);
    END IF;
    IF r.fn = ANY (executable_definers) THEN
      IF r.owner <> 'app_migrator' OR r.public_can_execute THEN
        problems := problems || format(
          '%s (SECURITY DEFINER liberada) precisa ser do app_migrator e fechada a PUBLIC', r.fn);
      END IF;
    ELSE
      IF r.public_can_execute THEN
        problems := problems || format('%s (SECURITY DEFINER) executável por PUBLIC', r.fn);
      END IF;
      IF cardinality(r.executors) > 0 THEN
        problems := problems || format('%s (SECURITY DEFINER) executável por %s', r.fn,
          array_to_string(r.executors, ', '));
      END IF;
    END IF;
  END LOOP;

  -- (g) Views (qualquer schema de usuário) usam security_invoker: senão rodam como o dono.
  FOR r IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'v'
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\_%'
       AND NOT EXISTS (SELECT FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                          AND d.deptype = 'e')
       AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)
  LOOP
    problems := problems || format('view %s sem security_invoker', r.rel);
  END LOOP;

  -- (g2) Materialized view e foreign table não aceitam RLS: nenhuma pode ser legível pela
  --      aplicação (copiaria dados de todos os tenants sem filtro).
  FOR r IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('m', 'f')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\_%'
       AND EXISTS (SELECT FROM unnest(runtime_roles) AS role_name
                    WHERE has_table_privilege(role_name, c.oid, 'SELECT'))
  LOOP
    problems := problems || format(
      '%s: materialized view ou foreign table legível pela aplicação (sem RLS)', r.rel);
  END LOOP;

  -- (h) Schemas e banco: PUBLIC sem USAGE/CREATE em app, app_private e auth; runtime sem USAGE
  --     em app_private e sem CREATE em schema nenhum nem no banco; só o app_auth usa o schema
  --     auth, e o app_auth não usa app nem app_private.
  FOR r IN
    SELECT format('schema %s: %s para PUBLIC', n.nspname, privilege) AS problem
      FROM pg_namespace n CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) AS privilege
     WHERE n.nspname IN ('app', 'app_private', 'auth')
       AND has_schema_privilege('public', n.oid, privilege)
    UNION ALL
    SELECT format('%s tem USAGE no schema auth (credenciais: só app_auth)', role_name)
      FROM pg_namespace n CROSS JOIN unnest(runtime_roles) AS role_name
     WHERE n.nspname = 'auth' AND role_name <> 'app_auth'
       AND EXISTS (SELECT FROM pg_roles WHERE rolname = role_name)
       AND has_schema_privilege(role_name, n.oid, 'USAGE')
    UNION ALL
    SELECT format('app_auth tem USAGE no schema %s (app_auth: só o schema auth)', n.nspname)
      FROM pg_namespace n
     WHERE n.nspname IN ('app', 'app_private')
       AND EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_auth')
       AND has_schema_privilege('app_auth', n.oid, 'USAGE')
    UNION ALL
    SELECT format('%s pode criar objetos no schema %s', role_name, n.nspname)
      FROM pg_namespace n CROSS JOIN unnest(runtime_roles) AS role_name
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\_%'
       AND has_schema_privilege(role_name, n.oid, 'CREATE')
    UNION ALL
    SELECT format('%s tem USAGE em app_private', role_name)
      FROM unnest(runtime_roles) AS role_name
     WHERE has_schema_privilege(role_name, 'app_private', 'USAGE')
    UNION ALL
    SELECT format('%s pode criar schemas no banco', role_name)
      FROM unnest(runtime_roles) AS role_name
     WHERE has_database_privilege(role_name, current_database(), 'CREATE')
  LOOP
    problems := problems || r.problem;
  END LOOP;

  -- (i) Triggers críticos presentes, habilitados e com a definição esperada. DISABLE TRIGGER,
  --     ou recriar o trigger com outro evento (AFTER UPDATE no lugar de AFTER INSERT), sem
  --     adiar para o COMMIT, com WHEN ou com outra função, desligaria a garantia.
  FOR i IN 1 .. array_length(required_triggers, 1) LOOP
    SELECT t.tgenabled IN ('O', 'A') AS enabled,
           concat_ws(' ',
             CASE WHEN t.tgconstraint <> 0 THEN 'CONSTRAINT' END,
             CASE WHEN t.tgtype & 2 <> 0 THEN 'BEFORE'
                  WHEN t.tgtype & 64 <> 0 THEN 'INSTEAD OF'
                  ELSE 'AFTER' END,
             concat_ws(' OR ',
               CASE WHEN t.tgtype & 4 <> 0 THEN 'INSERT' END,
               CASE WHEN t.tgtype & 16 <> 0 THEN concat_ws(' OF ', 'UPDATE', (
                 SELECT string_agg(a.attname::text, ', ' ORDER BY a.attname::text)
                   FROM pg_attribute a
                  WHERE a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr::int2[]))) END,
               CASE WHEN t.tgtype & 8 <> 0 THEN 'DELETE' END,
               CASE WHEN t.tgtype & 32 <> 0 THEN 'TRUNCATE' END),
             CASE WHEN t.tgdeferrable AND t.tginitdeferred THEN 'DEFERRABLE INITIALLY DEFERRED'
                  WHEN t.tgdeferrable THEN 'DEFERRABLE INITIALLY IMMEDIATE' END,
             CASE WHEN t.tgtype & 1 <> 0 THEN 'FOR EACH ROW' ELSE 'FOR EACH STATEMENT' END,
             CASE WHEN t.tgqual IS NOT NULL THEN 'WHEN (...)' END,
             CASE WHEN t.tgnargs > 0 THEN format('(%s argumentos)', t.tgnargs) END,
             'EXECUTE FUNCTION ' || t.tgfoid::regprocedure::text) AS definition
      INTO r
      FROM pg_trigger t
     WHERE t.tgrelid = to_regclass(required_triggers[i][1])
       AND t.tgname = required_triggers[i][2];
    IF NOT FOUND OR NOT r.enabled THEN
      problems := problems || format('trigger %s em %s ausente ou desabilitado',
        required_triggers[i][2], required_triggers[i][1]);
    ELSIF r.definition IS DISTINCT FROM required_triggers[i][3] THEN
      problems := problems || format('trigger %s em %s com definição inesperada: %s (esperada: %s)',
        required_triggers[i][2], required_triggers[i][1], r.definition, required_triggers[i][3]);
    END IF;
  END LOOP;

  -- (j) EXCLUDE anti-sobreposição presentes e validados.
  FOR i IN 1 .. array_length(required_exclusions, 1) LOOP
    IF NOT EXISTS (
      SELECT FROM pg_constraint k
       WHERE k.conrelid = to_regclass(required_exclusions[i][1])
         AND k.conname = required_exclusions[i][2]
         AND k.contype = 'x' AND k.convalidated
    ) THEN
      problems := problems || format('EXCLUDE %s em %s ausente',
        required_exclusions[i][2], required_exclusions[i][1]);
    END IF;
  END LOOP;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'invariantes de segurança do banco violadas: %', array_to_string(problems, '; ');
  END IF;
END
$$;
