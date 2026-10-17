-- =============================================================================
-- 0003 · Isolamento multi-tenant e integridade que o Drizzle não modela.
-- Roda como app_migrator (dono das tabelas).
--
--   1. Funções e triggers: updated_at, version, máquina de estados do agendamento,
--      ocupação derivada do status, auditoria append-only.
--   2. EXCLUDE anti-sobreposição (ocupação do profissional e jornada semanal).
--   3. RLS ENABLE + FORCE em toda tabela de tenant: política RESTRICTIVE de tenant
--      (vale para TODOS os papéis, inclusive o dono) + PERMISSIVE de acesso por papel.
--   4. GRANTs mínimos (nunca TRUNCATE/REFERENCES/TRIGGER) e função de invariantes que o
--      runner executa ao fim de toda migração (deploy falha se a segurança regredir).
--
-- Contexto de tenant: `NULLIF(current_setting('app.tenant_id', true), '')::uuid`, definido
-- por transação com set_config(..., true) (withTenant). Sem contexto => NULL => 0 linhas.
-- O `(SELECT ...)` em volta vira InitPlan: avaliado uma vez por consulta, não por linha.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Funções auxiliares e triggers
-- ---------------------------------------------------------------------------

-- Triggers SECURITY INVOKER não referenciam nada em app_private: o PL/pgSQL resolve nomes
-- em tempo de execução com o papel de quem dispara, e os papéis de runtime não têm USAGE
-- em app_private. Por isso a lista de status que ocupam a agenda (espelho de
-- occupiesSchedule() de @salon/scheduling-core) aparece literal abaixo.

CREATE FUNCTION app_private.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants', 'locations', 'staff', 'services', 'staff_services', 'working_hours',
    'time_off', 'customers', 'appointments', 'appointment_items', 'occupancies'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at()',
      t || '_touch_updated_at', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- Lock otimista: toda alteração de agendamento incrementa `version`
-- (UPDATE ... WHERE id = $1 AND version = $2; 0 linhas = alguém alterou antes).
CREATE FUNCTION app_private.appointments_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_bump_version
  BEFORE UPDATE ON app.appointments
  FOR EACH ROW EXECUTE FUNCTION app_private.appointments_bump_version();
--> statement-breakpoint
-- Máquina de estados: espelha allowedTransitions() de @salon/scheduling-core (a fonte).
-- src/status-machine-sync.test.ts compara este CASE com o core sem banco, e
-- status-transitions.int.test.ts percorre os 81 pares no banco real.
-- Nascimento só como pending/confirmed; terminais: completed, cancelled_by_customer,
-- cancelled_by_salon. Preenche o instante de cada transição e zera o hold ao confirmar.
CREATE FUNCTION app_private.appointments_guard_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  allowed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('pending', 'confirmed') THEN
      RAISE EXCEPTION 'agendamento não pode nascer com status %', NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_initial_status';
    END IF;
    IF NEW.status = 'confirmed' THEN
      NEW.hold_expires_at := NULL;
      NEW.confirmed_at := coalesce(NEW.confirmed_at, now());
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'pending'    THEN ARRAY['confirmed', 'cancelled_by_customer', 'cancelled_by_salon', 'expired']
    WHEN 'confirmed'  THEN ARRAY['checked_in', 'in_service', 'completed', 'cancelled_by_customer',
                                 'cancelled_by_salon', 'no_show']
    WHEN 'checked_in' THEN ARRAY['in_service', 'completed', 'cancelled_by_customer', 'cancelled_by_salon']
    WHEN 'in_service' THEN ARRAY['completed']
    WHEN 'no_show'    THEN ARRAY['checked_in']
    WHEN 'expired'    THEN ARRAY['confirmed']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'transição de status inválida: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_status_transition';
  END IF;

  CASE NEW.status
    WHEN 'confirmed' THEN
      NEW.hold_expires_at := NULL;
      NEW.confirmed_at := coalesce(NEW.confirmed_at, now());
    WHEN 'checked_in' THEN
      NEW.checked_in_at := coalesce(NEW.checked_in_at, now());
    WHEN 'in_service' THEN
      NEW.started_at := coalesce(NEW.started_at, now());
    WHEN 'completed' THEN
      NEW.completed_at := coalesce(NEW.completed_at, now());
    WHEN 'cancelled_by_customer', 'cancelled_by_salon' THEN
      NEW.cancelled_at := coalesce(NEW.cancelled_at, now());
    WHEN 'no_show' THEN
      NEW.no_show_at := coalesce(NEW.no_show_at, now());
    WHEN 'expired' THEN
      NEW.expired_at := coalesce(NEW.expired_at, now());
    ELSE
      NULL;
  END CASE;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_guard_status
  BEFORE INSERT OR UPDATE OF status ON app.appointments
  FOR EACH ROW EXECUTE FUNCTION app_private.appointments_guard_status();
--> statement-breakpoint
-- `occupancies.active` é DERIVADA do status do agendamento: o valor enviado é ignorado.
-- Status que ocupam: pending, confirmed, checked_in, in_service, completed.
-- FOR SHARE serializa com uma mudança de status concorrente (que pega FOR NO KEY UPDATE
-- na linha do agendamento), então uma ocupação nova nunca escapa da sincronização abaixo.
CREATE FUNCTION app_private.occupancies_derive_active()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  appointment_status text;
BEGIN
  SELECT a.status INTO appointment_status
    FROM app.appointments AS a
   WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.appointment_id
     FOR SHARE;
  -- Agendamento invisível/inexistente: a FK composta recusa a linha logo depois.
  IF FOUND THEN
    NEW.active := appointment_status IN ('pending', 'confirmed', 'checked_in', 'in_service', 'completed');
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER occupancies_derive_active
  BEFORE INSERT OR UPDATE ON app.occupancies
  FOR EACH ROW EXECUTE FUNCTION app_private.occupancies_derive_active();
--> statement-breakpoint
-- Cancelar/no-show/expirar libera a agenda; reativar (expired -> confirmed,
-- no_show -> checked_in) reocupa e o EXCLUDE re-checa o horário (23P01 se tomado).
CREATE FUNCTION app_private.appointments_sync_occupancies()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  occupying constant text[] := ARRAY['pending', 'confirmed', 'checked_in', 'in_service', 'completed'];
BEGIN
  IF (NEW.status = ANY (occupying)) IS DISTINCT FROM (OLD.status = ANY (occupying)) THEN
    -- O trigger occupancies_derive_active recalcula `active` a partir do novo status.
    UPDATE app.occupancies AS o
       SET active = (NEW.status = ANY (occupying))
     WHERE o.tenant_id = NEW.tenant_id AND o.appointment_id = NEW.id;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_sync_occupancies
  AFTER UPDATE OF status ON app.appointments
  FOR EACH ROW EXECUTE FUNCTION app_private.appointments_sync_occupancies();
--> statement-breakpoint
-- Auditoria: SECURITY DEFINER para que os papéis da aplicação NÃO precisem (nem tenham)
-- INSERT em appointment_events. O evento só nasce de uma transição real; a aplicação
-- informa o ator via GUCs app.actor_type/app.actor_id (withTenant). Roda como
-- app_migrator, que continua sujeito à política RESTRICTIVE de tenant (FORCE RLS).
CREATE FUNCTION app_private.appointments_write_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor_type text := coalesce(nullif(current_setting('app.actor_type', true), ''), 'unknown');
  v_actor_id text := nullif(current_setting('app.actor_id', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.appointment_events
      (tenant_id, appointment_id, event_type, from_status, to_status, actor_type, actor_id)
    VALUES
      (NEW.tenant_id, NEW.id, 'created', NULL, NEW.status, v_actor_type, v_actor_id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO app.appointment_events
      (tenant_id, appointment_id, event_type, from_status, to_status, actor_type, actor_id)
    VALUES
      (NEW.tenant_id, NEW.id, 'status_changed', OLD.status, NEW.status, v_actor_type, v_actor_id);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_write_event
  AFTER INSERT OR UPDATE OF status ON app.appointments
  FOR EACH ROW EXECUTE FUNCTION app_private.appointments_write_event();
--> statement-breakpoint
-- Append-only até para o dono: UPDATE/DELETE/TRUNCATE em appointment_events falham.
-- (Superusuário ainda pode desabilitar o trigger: isso fica registrado no log do servidor.)
CREATE FUNCTION app_private.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'a tabela %.% é append-only: % não é permitido', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_events_append_only
  BEFORE UPDATE OR DELETE ON app.appointment_events
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER appointment_events_no_truncate
  BEFORE TRUNCATE ON app.appointment_events
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Exclusão de sobreposição (btree_gist para os operadores = em uuid/smallint)
-- ---------------------------------------------------------------------------

-- Anti-overbooking: o mesmo profissional não tem duas ocupações ativas que se sobrepõem.
-- Intervalos semiabertos [início, fim): atendimentos encostados são permitidos.
ALTER TABLE app.occupancies
  ADD CONSTRAINT occupancies_no_staff_overlap
  EXCLUDE USING gist (tenant_id WITH =, staff_id WITH =, during WITH &&)
  WHERE (active);
--> statement-breakpoint
-- Jornada: sem faixas sobrepostas do mesmo profissional no mesmo dia da semana e vigência.
ALTER TABLE app.working_hours
  ADD CONSTRAINT working_hours_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    staff_id WITH =,
    weekday WITH =,
    daterange(valid_from, valid_until, '[]') WITH &&,
    app_private.time_range(start_time, end_time, '[)') WITH &&
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.tenants
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY app_access ON app.tenants
  AS PERMISSIVE FOR ALL TO app_user, app_worker
  USING (true) WITH CHECK (true);
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'locations', 'staff', 'services', 'staff_services', 'working_hours', 'time_off',
    'customers', 'appointments', 'appointment_items', 'occupancies', 'appointment_events'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$CREATE POLICY tenant_isolation ON app.%I AS RESTRICTIVE FOR ALL TO PUBLIC
           USING (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid))
           WITH CHECK (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid))$p$,
      t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'locations', 'staff', 'services', 'staff_services', 'working_hours', 'time_off',
    'customers', 'appointments', 'appointment_items', 'occupancies'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY app_access ON app.%I AS PERMISSIVE FOR ALL TO app_user, app_worker USING (true) WITH CHECK (true)',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- Auditoria: a aplicação só lê; quem escreve é o trigger SECURITY DEFINER (app_migrator).
CREATE POLICY app_read ON app.appointment_events
  AS PERMISSIVE FOR SELECT TO app_user, app_worker
  USING (true);
--> statement-breakpoint
CREATE POLICY audit_trigger_insert ON app.appointment_events
  AS PERMISSIVE FOR INSERT TO app_migrator
  WITH CHECK (true);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Privilégios mínimos
-- ---------------------------------------------------------------------------

REVOKE ALL ON SCHEMA app FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO app_user, app_worker;
--> statement-breakpoint
-- app_user (requisições web). Sem DELETE em appointments (cancela-se pelo status) e só
-- SELECT na auditoria. Sem TRUNCATE/REFERENCES/TRIGGER em nenhuma tabela.
GRANT SELECT, INSERT, UPDATE ON app.tenants TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON app.locations, app.staff, app.services, app.staff_services, app.working_hours,
     app.time_off, app.customers, app.appointment_items, app.occupancies
  TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.appointments TO app_user;
--> statement-breakpoint
GRANT SELECT ON app.appointment_events TO app_user;
--> statement-breakpoint
-- app_worker (jobs: expirar holds, marcar no-show, lembretes): lê tudo do tenant do job e
-- só altera status de agendamento (o trigger sincroniza as ocupações).
GRANT SELECT ON ALL TABLES IN SCHEMA app TO app_worker;
--> statement-breakpoint
GRANT UPDATE ON app.appointments, app.occupancies TO app_worker;
--> statement-breakpoint
-- Funções chamadas por CHECK são executadas com o papel de quem escreve. (Os construtores
-- do tipo range time_range pertencem ao superusuário de bootstrap e já são públicos; os
-- triggers não exigem EXECUTE de quem os dispara.)
GRANT EXECUTE ON FUNCTION
  app_private.is_valid_iana_timezone(text),
  app_private.service_phases_are_valid(jsonb, integer)
  TO app_user, app_worker;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Invariantes de segurança (executadas pelo runner ao fim de TODA execução)
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_private.assert_security_invariants()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  runtime_roles constant text[] := ARRAY['app_user', 'app_worker'];
  allowed_privileges constant text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
  problems text[] := ARRAY[]::text[];
  r record;
BEGIN
  -- (a) Toda tabela com tenant_id (em qualquer schema de usuário) e app.tenants:
  --     RLS habilitada, FORÇADA e com política RESTRICTIVE.
  FOR r IN
    SELECT c.oid::regclass AS rel, c.relrowsecurity, c.relforcerowsecurity,
           EXISTS (SELECT FROM pg_policy p WHERE p.polrelid = c.oid AND NOT p.polpermissive)
             AS has_restrictive
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
    IF NOT r.has_restrictive THEN
      problems := problems || format('%s: sem política RESTRICTIVE de tenant', r.rel);
    END IF;
  END LOOP;

  -- (b) Papéis: nenhum é superusuário nem tem BYPASSRLS (FORCE RLS não vale para eles).
  FOR r IN
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
     WHERE rolname = ANY (runtime_roles || ARRAY['app_migrator'])
  LOOP
    IF r.rolsuper OR r.rolbypassrls THEN
      problems := problems || format('papel %s é SUPERUSER ou BYPASSRLS', r.rolname);
    END IF;
  END LOOP;

  -- (c) Papéis de runtime não herdam nada: não são membros de nenhum papel.
  FOR r IN
    SELECT u.rolname AS member, g.rolname AS granted
      FROM pg_auth_members m
      JOIN pg_roles u ON u.oid = m.member
      JOIN pg_roles g ON g.oid = m.roleid
     WHERE u.rolname = ANY (runtime_roles)
  LOOP
    problems := problems || format('papel %s é membro de %s', r.member, r.granted);
  END LOOP;

  -- (d) Tudo em app/app_private pertence ao app_migrator (dono sujeito a FORCE RLS).
  FOR r IN
    SELECT c.oid::regclass AS rel, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('app', 'app_private')
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND pg_get_userbyid(c.relowner) <> 'app_migrator'
  LOOP
    problems := problems || format('%s pertence a %s (esperado app_migrator)', r.rel, r.owner);
  END LOOP;

  -- (e) Privilégios de tabela/coluna: PUBLIC nada; runtime só SELECT/INSERT/UPDATE/DELETE.
  FOR r IN
    SELECT c.oid::regclass AS rel, acl.grantee, acl.privilege_type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
     WHERE n.nspname IN ('app', 'app_private')
       AND (acl.grantee = 0
            OR (pg_get_userbyid(acl.grantee) = ANY (runtime_roles)
                AND acl.privilege_type <> ALL (allowed_privileges)))
    UNION ALL
    SELECT c.oid::regclass, acl.grantee, acl.privilege_type || ' (coluna ' || a.attname || ')'
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
     WHERE n.nspname IN ('app', 'app_private')
       AND (acl.grantee = 0
            OR (pg_get_userbyid(acl.grantee) = ANY (runtime_roles)
                AND acl.privilege_type <> ALL (allowed_privileges)))
  LOOP
    problems := problems || format('%s: privilégio %s concedido a %s', r.rel, r.privilege_type,
      CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r.grantee) END);
  END LOOP;

  -- (f) Nenhuma função SECURITY DEFINER executável por PUBLIC ou pelos papéis de runtime.
  FOR r IN
    SELECT p.oid::regprocedure AS fn, role_name
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     CROSS JOIN unnest(runtime_roles) AS role_name
     WHERE n.nspname IN ('app', 'app_private')
       AND p.prosecdef
       AND has_function_privilege(role_name, p.oid, 'EXECUTE')
  LOOP
    problems := problems || format('%s (SECURITY DEFINER) executável por %s', r.fn, r.role_name);
  END LOOP;

  -- (g) Views sobre tabelas com RLS precisam de security_invoker (senão rodam como o dono).
  FOR r IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app'
       AND c.relkind = 'v'
       AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)
  LOOP
    problems := problems || format('view %s sem security_invoker', r.rel);
  END LOOP;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'invariantes de segurança do banco violadas: %', array_to_string(problems, '; ');
  END IF;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION app_private.assert_security_invariants() IS
  'Falha se RLS/papéis/privilégios regredirem. O runner (src/migrate.ts) chama ao fim de toda execução.';
