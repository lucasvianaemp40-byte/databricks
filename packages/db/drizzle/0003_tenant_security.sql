-- =============================================================================
-- 0003 · Isolamento multi-tenant e integridade que o Drizzle não modela.
-- Roda como app_migrator (dono das tabelas).
--
--   1. Funções e triggers: updated_at, version, máquina de estados do agendamento (com os
--      instantes de transição), fuso da unidade, ocupação derivada do status e amarrada ao
--      item, completude das ocupações no COMMIT, auditoria append-only.
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

-- `created_at` e `updated_at` são do banco: o valor enviado pela aplicação é ignorado no
-- INSERT e no UPDATE (`created_at` nunca muda depois de criado).
CREATE FUNCTION app_private.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;
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
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at()',
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
-- cancelled_by_salon.
--
-- Os instantes de transição e o hold são do BANCO (o valor enviado é ignorado, como em
-- occupancies.active): no INSERT só existe o instante do status inicial; no UPDATE nenhum
-- instante muda, exceto o do status de destino de uma transição, gravado com now(). O hold só
-- muda enquanto o agendamento continua pending e é zerado ao confirmar. Dispara em TODO UPDATE
-- (não só `OF status`): senão um UPDATE sem status reescreveria os instantes livremente.
-- Unidade, fuso e horário da visita são imutáveis: remarcar é criar outro agendamento
-- (rescheduled_from_id); mover a visita deixaria a ocupação no horário antigo.
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
    NEW.checked_in_at := NULL;
    NEW.started_at := NULL;
    NEW.completed_at := NULL;
    NEW.cancelled_at := NULL;
    NEW.no_show_at := NULL;
    NEW.expired_at := NULL;
    IF NEW.status = 'confirmed' THEN
      NEW.hold_expires_at := NULL;
      NEW.confirmed_at := now();
    ELSE
      NEW.confirmed_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.location_id, NEW.timezone, NEW.starts_at, NEW.ends_at, NEW.local_starts_at,
      NEW.local_utc_offset_seconds)
     IS DISTINCT FROM
     (OLD.location_id, OLD.timezone, OLD.starts_at, OLD.ends_at, OLD.local_starts_at,
      OLD.local_utc_offset_seconds) THEN
    RAISE EXCEPTION 'unidade, fuso e horário do agendamento são imutáveis (remarcar = novo agendamento)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_schedule_immutable';
  END IF;

  NEW.confirmed_at := OLD.confirmed_at;
  NEW.checked_in_at := OLD.checked_in_at;
  NEW.started_at := OLD.started_at;
  NEW.completed_at := OLD.completed_at;
  NEW.cancelled_at := OLD.cancelled_at;
  NEW.no_show_at := OLD.no_show_at;
  NEW.expired_at := OLD.expired_at;
  IF OLD.status <> 'pending' OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.hold_expires_at := OLD.hold_expires_at;
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
      NEW.confirmed_at := now();
    WHEN 'checked_in' THEN
      NEW.checked_in_at := now();
    WHEN 'in_service' THEN
      NEW.started_at := now();
    WHEN 'completed' THEN
      NEW.completed_at := now();
    WHEN 'cancelled_by_customer', 'cancelled_by_salon' THEN
      NEW.cancelled_at := now();
    WHEN 'no_show' THEN
      NEW.no_show_at := now();
    WHEN 'expired' THEN
      NEW.expired_at := now();
    ELSE
      NULL;
  END CASE;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_guard_status
  BEFORE INSERT OR UPDATE ON app.appointments
  FOR EACH ROW EXECUTE FUNCTION app_private.appointments_guard_status();
--> statement-breakpoint
-- O fuso do agendamento é o da unidade no momento da reserva (snapshot), conferido no INSERT
-- (depois, unidade e fuso são imutáveis). Se a unidade trocar de fuso, os agendamentos já
-- marcados mantêm o fuso (e o offset) com que foram reservados.
CREATE FUNCTION app_private.appointments_guard_location_timezone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  location_timezone text;
BEGIN
  SELECT l.timezone INTO location_timezone
    FROM app.locations AS l
   WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.location_id;
  -- Unidade invisível/inexistente: a FK composta recusa a linha logo depois.
  IF FOUND AND NEW.timezone IS DISTINCT FROM location_timezone THEN
    RAISE EXCEPTION 'o fuso do agendamento precisa ser o fuso da unidade'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_timezone_matches_location';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_guard_location_timezone
  BEFORE INSERT ON app.appointments
  FOR EACH ROW EXECUTE FUNCTION app_private.appointments_guard_location_timezone();
--> statement-breakpoint
-- `occupancies.active` é DERIVADA do status do agendamento: o valor enviado é ignorado.
-- Status que ocupam: pending, confirmed, checked_in, in_service, completed.
-- FOR SHARE serializa com uma mudança de status concorrente (que pega FOR NO KEY UPDATE
-- na linha do agendamento), então uma ocupação nova nunca escapa da sincronização abaixo.
-- Vale em READ COMMITTED (cada comando do trigger de sincronização vê os commits anteriores):
-- withTenant fixa esse nível. Em REPEATABLE READ o UPDATE de sincronização usaria o snapshot
-- do início da transação e deixaria ativa a ocupação criada em paralelo a um cancelamento.
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
  -- Agendamento invisível/inexistente: a FK composta recusa a linha logo depois. Até lá,
  -- falha fechada: nunca mantém o `active` enviado pela aplicação.
  NEW.active := FOUND
    AND appointment_status IN ('pending', 'confirmed', 'checked_in', 'in_service', 'completed');
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
-- A ocupação cabe na janela do item: qualquer trecho fica dentro da janela visível ampliada
-- pelos buffers congelados no item, e um trecho `service` toca a janela visível. O profissional
-- é o do item pela FK composta (tenant_id, appointment_id, appointment_item_id, staff_id).
CREATE FUNCTION app_private.occupancies_guard_within_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  item record;
  piece tstzrange;
BEGIN
  -- Nulos e intervalo invertido: os CHECKs/NOT NULL da tabela recusam com o erro próprio.
  IF NEW.starts_at IS NULL OR NEW.ends_at IS NULL OR NEW.ends_at <= NEW.starts_at THEN
    RETURN NEW;
  END IF;
  SELECT i.starts_at, i.ends_at, i.buffer_before_min, i.buffer_after_min INTO item
    FROM app.appointment_items AS i
   WHERE i.tenant_id = NEW.tenant_id AND i.appointment_id = NEW.appointment_id
     AND i.id = NEW.appointment_item_id AND i.staff_id = NEW.staff_id;
  -- Item invisível, inexistente ou de outro profissional: a FK composta recusa logo depois.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  piece := tstzrange(NEW.starts_at, NEW.ends_at, '[)');
  IF NOT piece <@ tstzrange(item.starts_at - make_interval(mins => item.buffer_before_min),
                            item.ends_at + make_interval(mins => item.buffer_after_min), '[)')
     OR (NEW.kind = 'service' AND NOT piece && tstzrange(item.starts_at, item.ends_at, '[)')) THEN
    RAISE EXCEPTION 'ocupação fora da janela do item (início/fim do serviço e buffers)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'occupancies_within_item';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER occupancies_guard_within_item
  BEFORE INSERT OR UPDATE OF appointment_id, appointment_item_id, staff_id, kind, starts_at, ends_at
  ON app.occupancies
  FOR EACH ROW EXECUTE FUNCTION app_private.occupancies_guard_within_item();
--> statement-breakpoint
-- Item: visita, profissional, horário, fases e buffers são imutáveis (remarcar = novo agendamento,
-- com rescheduled_from_id), e um item com ocupação ativa não é apagado (o DELETE em cascata
-- levaria a ocupação junto e liberaria o horário de um agendamento que ainda ocupa a agenda).
CREATE FUNCTION app_private.appointment_items_guard_schedule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.appointment_id, NEW.staff_id, NEW.starts_at, NEW.ends_at, NEW.duration_min,
        NEW.phases, NEW.buffer_before_min, NEW.buffer_after_min)
       IS DISTINCT FROM
       (OLD.appointment_id, OLD.staff_id, OLD.starts_at, OLD.ends_at, OLD.duration_min,
        OLD.phases, OLD.buffer_before_min, OLD.buffer_after_min) THEN
      RAISE EXCEPTION 'visita, profissional, horário, fases e buffers do item são imutáveis (remarcar = novo agendamento)'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'appointment_items_schedule_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT FROM app.occupancies AS o
     WHERE o.tenant_id = OLD.tenant_id AND o.appointment_id = OLD.appointment_id
       AND o.appointment_item_id = OLD.id AND o.active
  ) THEN
    RAISE EXCEPTION 'item com ocupação ativa não pode ser apagado (cancele o agendamento antes)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'appointment_items_schedule_immutable';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_items_guard_schedule
  BEFORE UPDATE OR DELETE ON app.appointment_items
  FOR EACH ROW EXECUTE FUNCTION app_private.appointment_items_guard_schedule();
--> statement-breakpoint
-- Completude, conferida no COMMIT (constraint trigger adiada): um agendamento que ocupa a
-- agenda tem ao menos um item, todo item cabe na janela da visita, e as ocupações `service`
-- ativas de cada item cobrem cada uma das suas fases `work` (fases congeladas no item). Sem
-- isso a aplicação poderia confirmar uma visita cujo horário o EXCLUDE nunca viu (item sem
-- ocupação, ou uma ocupação de 1 minuto num serviço de 1 hora).
CREATE FUNCTION app_private.appointments_assert_occupancy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant_id uuid := NEW.tenant_id;
  v_appointment_id uuid;
  v_visit record;
  v_item record;
  v_phase jsonb;
  v_covered tstzmultirange;
  v_offset integer;
  v_items integer := 0;
BEGIN
  IF TG_TABLE_NAME = 'appointments' THEN
    v_appointment_id := NEW.id;
  ELSE
    v_appointment_id := NEW.appointment_id;
  END IF;
  SELECT a.status, a.starts_at, a.ends_at INTO v_visit
    FROM app.appointments AS a
   WHERE a.tenant_id = v_tenant_id AND a.id = v_appointment_id;
  IF NOT FOUND OR v_visit.status NOT IN ('pending', 'confirmed', 'checked_in', 'in_service', 'completed') THEN
    RETURN NULL;
  END IF;
  FOR v_item IN
    SELECT i.id, i.starts_at, i.ends_at, i.phases
      FROM app.appointment_items AS i
     WHERE i.tenant_id = v_tenant_id AND i.appointment_id = v_appointment_id
  LOOP
    v_items := v_items + 1;
    IF NOT tstzrange(v_item.starts_at, v_item.ends_at, '[)')
           <@ tstzrange(v_visit.starts_at, v_visit.ends_at, '[)') THEN
      RAISE EXCEPTION 'item fora da janela do agendamento'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_occupancy_required';
    END IF;
    SELECT range_agg(o.during) INTO v_covered
      FROM app.occupancies AS o
     WHERE o.tenant_id = v_tenant_id AND o.appointment_id = v_appointment_id
       AND o.appointment_item_id = v_item.id AND o.kind = 'service' AND o.active;
    v_offset := 0;
    FOR v_phase IN SELECT value FROM jsonb_array_elements(v_item.phases) LOOP
      IF v_phase ->> 'kind' = 'work'
         AND (v_covered IS NULL
              OR NOT v_covered @> tstzrange(
                   v_item.starts_at + make_interval(mins => v_offset),
                   v_item.starts_at + make_interval(mins => v_offset + (v_phase ->> 'minutes')::integer),
                   '[)')) THEN
        RAISE EXCEPTION 'fase de trabalho do item sem ocupação ativa: o horário não estaria protegido'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_occupancy_required';
      END IF;
      v_offset := v_offset + (v_phase ->> 'minutes')::integer;
    END LOOP;
  END LOOP;
  IF v_items = 0 THEN
    RAISE EXCEPTION 'agendamento que ocupa a agenda precisa de ao menos um item'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_occupancy_required';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER appointments_occupancy_required
  AFTER INSERT OR UPDATE OF status ON app.appointments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_private.appointments_assert_occupancy();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER appointment_items_occupancy_required
  AFTER INSERT ON app.appointment_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_private.appointments_assert_occupancy();
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
     app.time_off, app.customers, app.appointment_items
  TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.appointments TO app_user;
--> statement-breakpoint
-- Ocupação: a aplicação cria e lê. Sem DELETE nem UPDATE de profissional/horário/item:
-- esconder ou mover a ocupação furaria o EXCLUDE. UPDATE só de `active`, para o trigger de
-- sincronização (SECURITY INVOKER, roda com o papel de quem muda o status); o valor enviado
-- pela aplicação é ignorado pelo trigger que deriva `active` do status.
GRANT SELECT, INSERT ON app.occupancies TO app_user;
--> statement-breakpoint
GRANT SELECT ON app.appointment_events TO app_user;
--> statement-breakpoint
-- app_worker (jobs: expirar holds, marcar no-show, lembretes): lê tudo do tenant do job e só
-- altera o STATUS do agendamento, por GRANT de coluna. Instantes, version e updated_at são
-- preenchidos por triggers BEFORE (não exigem privilégio de coluna); o FOR SHARE do trigger de
-- ocupação exige UPDATE em ao menos uma coluna (status basta). Job novo que precise escrever
-- outra coluna ganha GRANT de coluna explícito numa migração nova.
GRANT SELECT ON ALL TABLES IN SCHEMA app TO app_worker;
--> statement-breakpoint
GRANT UPDATE (status) ON app.appointments TO app_worker;
--> statement-breakpoint
GRANT UPDATE (active) ON app.occupancies TO app_user, app_worker;
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

-- Portão do deploy: o runner chama ao fim de TODA execução (e confere o hash do corpo desta
-- função, src/migrate.ts) e nada é commitado se algo regrediu. Cobre o que uma migração ou um
-- ajuste manual (drift) pode quebrar sem que o CI perceba. Não protege contra migração
-- maliciosa (quem migra é dono de tudo): para isso valem revisão e os meta-testes do test:db.
-- Escopo: todos os schemas de usuário (fora pg_*, information_schema e objetos de extensão).
CREATE FUNCTION app_private.assert_security_invariants()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  runtime_roles constant text[] := ARRAY['app_user', 'app_worker'];
  app_roles constant text[] := ARRAY['app_migrator', 'app_user', 'app_worker'];
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

  -- (d) Posse: tudo em app/app_private (relações, funções, tipos e os schemas) pertence ao
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
     WHERE (o.nspname IN ('app', 'app_private') AND o.owner <> 'app_migrator')
        OR (o.owner = ANY (runtime_roles)
            AND o.nspname NOT IN ('pg_catalog', 'information_schema')
            AND o.nspname NOT LIKE 'pg\_%')
  LOOP
    problems := problems || format('%s pertence a %s (esperado app_migrator)', r.label, r.owner);
  END LOOP;

  -- (e) Privilégios de tabela/coluna em qualquer schema de usuário: PUBLIC nada; runtime só
  --     SELECT/INSERT/UPDATE/DELETE. app_worker não insere nem apaga e altera só por GRANT de
  --     coluna (nunca UPDATE na tabela inteira); a aplicação só lê a auditoria, não apaga
  --     agendamento e não apaga nem move ocupação (UPDATE só de `active`).
  FOR r IN
    WITH relations AS (
      SELECT c.oid, c.oid::regclass AS rel, c.relacl
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

  -- (h) Schemas e banco: PUBLIC sem USAGE/CREATE em app e app_private; runtime sem USAGE em
  --     app_private e sem CREATE em schema nenhum nem no banco.
  FOR r IN
    SELECT format('schema %s: %s para PUBLIC', n.nspname, privilege) AS problem
      FROM pg_namespace n CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) AS privilege
     WHERE n.nspname IN ('app', 'app_private')
       AND has_schema_privilege('public', n.oid, privilege)
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
--> statement-breakpoint
COMMENT ON FUNCTION app_private.assert_security_invariants() IS
  'Falha se RLS, papéis, posse, privilégios, SECURITY DEFINER, triggers ou EXCLUDE regredirem. O runner (src/migrate.ts) confere o hash do corpo e chama ao fim de toda execução.';
