import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/client';
import { PG_ERROR, TenantIsolationError } from '../../src/errors';
import { appointmentEvents } from '../../src/schema';
import { withTenant } from '../../src/tenant';
import {
  captureSqlState,
  connectAsAdmin,
  connectAsAppUser,
  listTenantTables,
} from '../helpers/connections';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';

const RUNTIME_ROLES = ['app_user', 'app_worker'] as const;

/**
 * Meta-testes de catálogo: verificam a configuração IMPLANTADA (não a declarada). Uma tabela
 * nova sem RLS, um GRANT a mais ou um papel com BYPASSRLS quebra estes testes.
 */
describe('catálogo: RLS, papéis e privilégios', () => {
  let admin: pg.Pool;
  let tenantTables: string[];

  beforeAll(async () => {
    admin = connectAsAdmin();
    tenantTables = await listTenantTables(admin);
  });

  afterAll(async () => {
    await admin.end();
  });

  it('toda tabela com tenant_id (em qualquer schema) tem RLS habilitada, FORÇADA e com política', async () => {
    const { rows } = await admin.query<{ rel: string }>(`
      SELECT c.oid::regclass::text AS rel
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                           AND a.attnum > 0 AND NOT a.attisdropped
       WHERE c.relkind IN ('r', 'p')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
              OR NOT EXISTS (SELECT FROM pg_policy p WHERE p.polrelid = c.oid))`);
    expect(rows).toEqual([]);
    expect(tenantTables.length).toBeGreaterThanOrEqual(11);
  });

  it('toda tabela do schema app (inclusive tenants) tem RLS forçada', async () => {
    const { rows } = await admin.query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`);
    expect(rows).toEqual([]);
  });

  it('cada tabela de tenant tem a política RESTRICTIVE de tenant (para PUBLIC) baseada em app.tenant_id', async () => {
    const { rows } = await admin.query<{
      table: string;
      roles: string[];
      cmd: string;
      qual: string;
      check: string;
    }>(`
      SELECT c.relname AS table,
             ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END
                     FROM unnest(p.polroles) AS r)::text[] AS roles,
             p.polcmd::text AS cmd,
             pg_get_expr(p.polqual, p.polrelid) AS qual,
             pg_get_expr(p.polwithcheck, p.polrelid) AS check
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND NOT p.polpermissive
       ORDER BY c.relname`);
    const tablesWithGuard = rows.map((row) => row.table);
    expect(tablesWithGuard).toEqual([...tenantTables, 'tenants'].sort());
    for (const row of rows) {
      expect(row.roles, row.table).toEqual(['public']);
      expect(row.cmd, row.table).toBe('*');
      for (const expression of [row.qual, row.check]) {
        // Formato do deparse pode variar entre versões (casts ::text): compara por regex.
        expect(expression, row.table).toMatch(
          /NULLIF\(current_setting\('app\.tenant_id'(::text)?, true\), ''(::text)?\)/,
        );
        expect(expression, row.table).toMatch(
          row.table === 'tenants' ? /^\(id = / : /^\(tenant_id = /,
        );
      }
    }
  });

  it('papéis de runtime: sem SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB e sem herdar nenhum papel', async () => {
    const { rows } = await admin.query(`
      SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit,
             rolcanlogin
        FROM pg_roles WHERE rolname IN ('app_user', 'app_worker', 'app_migrator') ORDER BY rolname`);
    expect(rows).toEqual([
      {
        rolname: 'app_migrator',
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolinherit: false,
        // O dono só é assumido por SET ROLE no deploy: logado, desligaria a RLS.
        rolcanlogin: false,
      },
      {
        rolname: 'app_user',
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolinherit: false,
        rolcanlogin: true,
      },
      {
        rolname: 'app_worker',
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolinherit: false,
        rolcanlogin: true,
      },
    ]);

    // Não é membro (direto ou transitivo) de nenhum papel com SUPERUSER/BYPASSRLS, nem de
    // nenhum outro papel: pg_has_role(MEMBER) cobre a cadeia inteira de pertencimento.
    const { rows: memberships } = await admin.query(`
      SELECT u.rolname AS member, r.rolname AS role
        FROM pg_roles u CROSS JOIN pg_roles r
       WHERE u.rolname IN ('app_user', 'app_worker', 'app_migrator') AND r.oid <> u.oid
         AND pg_has_role(u.oid, r.oid, 'MEMBER')`);
    expect(memberships).toEqual([]);
  });

  it('papéis de runtime não são donos de nenhum objeto; tudo em app/app_private é do app_migrator', async () => {
    const { rows: owned } = await admin.query(`
      SELECT c.oid::regclass::text AS rel, pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c
       WHERE pg_get_userbyid(c.relowner) IN ('app_user', 'app_worker')
      UNION ALL
      SELECT n.nspname, pg_get_userbyid(n.nspowner) FROM pg_namespace n
       WHERE pg_get_userbyid(n.nspowner) IN ('app_user', 'app_worker')
      UNION ALL
      SELECT p.oid::regprocedure::text, pg_get_userbyid(p.proowner) FROM pg_proc p
       WHERE pg_get_userbyid(p.proowner) IN ('app_user', 'app_worker')`);
    expect(owned).toEqual([]);

    const { rows: notMigrator } = await admin.query(`
      SELECT c.oid::regclass::text AS rel, pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('app', 'app_private') AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
         AND pg_get_userbyid(c.relowner) <> 'app_migrator'`);
    expect(notMigrator).toEqual([]);
  });

  it('papéis de runtime não têm TRUNCATE, REFERENCES, TRIGGER (nem MAINTAIN no PG17+) em tabela nenhuma', async () => {
    const { rows } = await admin.query(`
      SELECT c.oid::regclass::text AS rel, pg_get_userbyid(acl.grantee) AS grantee, acl.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND (acl.grantee = 0 OR pg_get_userbyid(acl.grantee) IN ('app_user', 'app_worker'))
         AND acl.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')`);
    expect(rows).toEqual([]);

    for (const role of RUNTIME_ROLES) {
      for (const table of [...tenantTables, 'tenants']) {
        const { rows: privileges } = await admin.query<{
          truncate: boolean;
          references: boolean;
          trigger: boolean;
        }>(
          `SELECT has_table_privilege($1, $2, 'TRUNCATE') AS truncate,
                  has_table_privilege($1, $2, 'REFERENCES') AS references,
                  has_table_privilege($1, $2, 'TRIGGER') AS trigger`,
          [role, `app.${table}`],
        );
        expect(privileges[0], `${role} em ${table}`).toEqual({
          truncate: false,
          references: false,
          trigger: false,
        });
      }
    }
  });

  it('app_worker só tem UPDATE por coluna (status, active); ninguém da aplicação apaga ou move ocupação', async () => {
    const { rows: tableLevel } = await admin.query(`
      SELECT c.relname AS table, pg_get_userbyid(acl.grantee) AS grantee, acl.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
       WHERE n.nspname = 'app'
         AND acl.privilege_type IN ('UPDATE', 'DELETE')
         AND (pg_get_userbyid(acl.grantee) = 'app_worker'
              OR (c.relname = 'occupancies'
                  AND pg_get_userbyid(acl.grantee) IN ('app_user', 'app_worker')))`);
    expect(tableLevel).toEqual([]);

    const { rows: columns } = await admin.query(`
      SELECT pg_get_userbyid(acl.grantee) AS grantee, c.relname || '.' || a.attname AS column
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
       WHERE n.nspname = 'app' AND acl.privilege_type = 'UPDATE'
       ORDER BY 1, 2`);
    expect(columns).toEqual([
      { grantee: 'app_user', column: 'occupancies.active' },
      { grantee: 'app_worker', column: 'appointments.status' },
      { grantee: 'app_worker', column: 'occupancies.active' },
    ]);
  });

  it('PUBLIC não tem privilégio em app nem em app_private; runtime não acessa app_private', async () => {
    const { rows } = await admin.query(`
      SELECT nspname,
             has_schema_privilege('public', oid, 'USAGE') AS public_usage,
             has_schema_privilege('app_user', oid, 'USAGE') AS app_user_usage,
             has_schema_privilege('app_user', oid, 'CREATE') AS app_user_create
        FROM pg_namespace WHERE nspname IN ('app', 'app_private') ORDER BY nspname`);
    expect(rows).toEqual([
      { nspname: 'app', public_usage: false, app_user_usage: true, app_user_create: false },
      {
        nspname: 'app_private',
        public_usage: false,
        app_user_usage: false,
        app_user_create: false,
      },
    ]);
  });

  it('app_user não consegue assumir o papel dono (app_migrator)', async () => {
    const { rows } = await admin.query(
      `SELECT pg_has_role('app_user', 'app_migrator', 'SET') AS can_set,
              pg_has_role('app_worker', 'app_migrator', 'SET') AS worker_can_set`,
    );
    expect(rows[0]).toEqual({ can_set: false, worker_can_set: false });
  });

  it('nenhuma função SECURITY DEFINER (em schema nenhum) é executável pela aplicação ou por PUBLIC', async () => {
    const { rows } = await admin.query(`
      SELECT p.oid::regprocedure::text AS fn, r AS role
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       CROSS JOIN unnest(ARRAY['app_user', 'app_worker', 'public']) AS r
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
         AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                            AND d.objid = p.oid AND d.deptype = 'e')
         AND p.prosecdef
         AND has_function_privilege(r, p.oid, 'EXECUTE')`);
    expect(rows).toEqual([]);
  });

  it('toda UNIQUE/EXCLUDE de tabela de tenant começa por tenant_id (fora a PK id)', async () => {
    const { rows } = await admin.query(`
      SELECT c.relname AS table, i.indexrelid::regclass::text AS index
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_constraint k ON k.conindid = i.indexrelid
       WHERE n.nspname = 'app'
         AND c.relname <> 'tenants'
         AND (i.indisunique OR k.contype = 'x')
         AND NOT i.indisprimary
         AND (i.indkey[0] = 0
              OR (SELECT attname FROM pg_attribute WHERE attrelid = c.oid AND attnum = i.indkey[0]) <> 'tenant_id')`);
    expect(rows).toEqual([]);
  });

  it('toda FK entre tabelas de tenant inclui tenant_id -> tenant_id (FK composta)', async () => {
    const { rows } = await admin.query(`
      SELECT k.conname,
             (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS columns,
             (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(k.confkey) WITH ORDINALITY AS u(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum) AS referenced,
             k.confrelid::regclass::text AS target
        FROM pg_constraint k
        JOIN pg_namespace n ON n.oid = k.connamespace
       WHERE k.contype = 'f' AND n.nspname = 'app'
       ORDER BY k.conname`);
    expect(rows.length).toBeGreaterThan(10);
    for (const fk of rows as {
      conname: string;
      columns: string[];
      referenced: string[];
      target: string;
    }[]) {
      if (fk.target === 'app.tenants') {
        expect(fk, fk.conname).toMatchObject({ columns: ['tenant_id'], referenced: ['id'] });
      } else {
        expect(fk.columns[0], fk.conname).toBe('tenant_id');
        expect(fk.referenced[0], fk.conname).toBe('tenant_id');
      }
    }
  });

  it('views em app usam security_invoker (hoje não há nenhuma; protege as futuras)', async () => {
    const { rows } = await admin.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND c.relkind = 'v'
         AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)`);
    expect(rows).toEqual([]);
  });

  it('assert_security_invariants() passa no banco migrado', async () => {
    await expect(
      admin.query(
        'SET ROLE app_migrator; SELECT app_private.assert_security_invariants(); RESET ROLE',
      ),
    ).resolves.toBeDefined();
  });

  it.each([
    ['tabela sem FORCE', 'ALTER TABLE app.customers NO FORCE ROW LEVEL SECURITY', /RLS sem FORCE/],
    ['tabela sem RLS', 'ALTER TABLE app.staff DISABLE ROW LEVEL SECURITY', /RLS desabilitada/],
    ['TRUNCATE concedido', 'GRANT TRUNCATE ON app.customers TO app_user', /privilégio TRUNCATE/],
    [
      'REFERENCES em coluna',
      'GRANT REFERENCES (id) ON app.customers TO app_worker',
      /REFERENCES \(coluna id\)/,
    ],
    ['papel com BYPASSRLS', 'ALTER ROLE app_worker BYPASSRLS', /BYPASSRLS/],
    [
      'tabela de tenant nova sem RLS',
      'CREATE TABLE app.leak (tenant_id uuid NOT NULL)',
      /app\.leak: RLS desabilitada/,
    ],
    [
      'papel de runtime herdando outro',
      'GRANT app_migrator TO app_user',
      /app_user é membro de app_migrator/,
    ],
    [
      'política de tenant só para um papel',
      'ALTER POLICY tenant_isolation ON app.customers TO app_worker',
      /app\.customers: sem política RESTRICTIVE de tenant canônica/,
    ],
    [
      'política de tenant sempre verdadeira',
      'ALTER POLICY tenant_isolation ON app.customers USING (true) WITH CHECK (true)',
      /app\.customers: sem política RESTRICTIVE de tenant canônica/,
    ],
    [
      'guarda RESTRICTIVE só para SELECT (INSERT/UPDATE sem guarda)',
      `DROP POLICY tenant_isolation ON app.customers;
       CREATE POLICY tenant_select ON app.customers AS RESTRICTIVE FOR SELECT TO PUBLIC
         USING (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid))`,
      /app\.customers: sem política RESTRICTIVE de tenant canônica/,
    ],
    [
      'SECURITY DEFINER executável pela aplicação em schema novo',
      `CREATE SCHEMA app_api;
       GRANT USAGE ON SCHEMA app_api TO app_user;
       CREATE FUNCTION app_api.forge() RETURNS integer LANGUAGE sql SECURITY DEFINER
         SET search_path = pg_catalog AS 'SELECT 1';
       REVOKE EXECUTE ON FUNCTION app_api.forge() FROM PUBLIC;
       GRANT EXECUTE ON FUNCTION app_api.forge() TO app_user`,
      /app_api\.forge\(\) \(SECURITY DEFINER\) executável por app_user/,
    ],
    [
      'SECURITY DEFINER sem search_path fixo',
      `CREATE FUNCTION app_private.no_search_path() RETURNS integer LANGUAGE sql SECURITY DEFINER
         AS 'SELECT 1';
       ALTER FUNCTION app_private.no_search_path() OWNER TO app_migrator;
       REVOKE EXECUTE ON FUNCTION app_private.no_search_path() FROM PUBLIC`,
      /app_private\.no_search_path\(\) \(SECURITY DEFINER\) sem search_path fixo/,
    ],
    [
      'função em app_private com dono app_user',
      `CREATE FUNCTION app_private.owned() RETURNS integer LANGUAGE sql AS 'SELECT 1';
       ALTER FUNCTION app_private.owned() OWNER TO app_user`,
      /função app_private\.owned\(\) pertence a app_user/,
    ],
    [
      'tabela de tenant em schema novo com TRUNCATE para a aplicação',
      `CREATE SCHEMA app_x;
       CREATE TABLE app_x.t (tenant_id uuid NOT NULL);
       ALTER TABLE app_x.t ENABLE ROW LEVEL SECURITY;
       ALTER TABLE app_x.t FORCE ROW LEVEL SECURITY;
       CREATE POLICY tenant_isolation ON app_x.t AS RESTRICTIVE FOR ALL TO PUBLIC
         USING (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid))
         WITH CHECK (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid));
       GRANT USAGE ON SCHEMA app_x TO app_user;
       GRANT TRUNCATE ON app_x.t TO app_user`,
      /app_x\.t: privilégio TRUNCATE concedido a app_user/,
    ],
    [
      'USAGE de PUBLIC no schema app',
      'GRANT USAGE ON SCHEMA app TO PUBLIC',
      /schema app: USAGE para PUBLIC/,
    ],
    [
      'CREATE no schema app para a aplicação',
      'GRANT CREATE ON SCHEMA app TO app_user',
      /app_user pode criar objetos no schema app/,
    ],
    [
      'trigger append-only removido',
      'DROP TRIGGER appointment_events_append_only ON app.appointment_events',
      /trigger appointment_events_append_only em app\.appointment_events ausente/,
    ],
    [
      'trigger que deriva a ocupação desabilitado',
      'ALTER TABLE app.occupancies DISABLE TRIGGER occupancies_derive_active',
      /trigger occupancies_derive_active em app\.occupancies ausente ou desabilitado/,
    ],
    [
      'cobertura do item recriada para AFTER UPDATE (item novo deixaria de ser conferido)',
      `DROP TRIGGER appointment_items_occupancy_required ON app.appointment_items;
       CREATE CONSTRAINT TRIGGER appointment_items_occupancy_required
         AFTER UPDATE ON app.appointment_items DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION app_private.appointments_assert_occupancy()`,
      /trigger appointment_items_occupancy_required em app\.appointment_items com definição inesperada/,
    ],
    [
      'cobertura da visita recriada como trigger comum (sem adiar para o COMMIT)',
      `DROP TRIGGER appointments_occupancy_required ON app.appointments;
       CREATE TRIGGER appointments_occupancy_required
         AFTER INSERT OR UPDATE OF status ON app.appointments
         FOR EACH ROW EXECUTE FUNCTION app_private.appointments_assert_occupancy()`,
      /trigger appointments_occupancy_required em app\.appointments com definição inesperada/,
    ],
    [
      'imutabilidade do item apontada para outra função',
      `DROP TRIGGER appointment_items_guard_schedule ON app.appointment_items;
       CREATE TRIGGER appointment_items_guard_schedule
         BEFORE UPDATE OR DELETE ON app.appointment_items
         FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at()`,
      /trigger appointment_items_guard_schedule em app\.appointment_items com definição inesperada/,
    ],
    [
      'auditoria desligada por WHEN (false)',
      `DROP TRIGGER appointments_write_event ON app.appointments;
       CREATE TRIGGER appointments_write_event
         AFTER INSERT OR UPDATE OF status ON app.appointments
         FOR EACH ROW WHEN (false) EXECUTE FUNCTION app_private.appointments_write_event()`,
      /trigger appointments_write_event em app\.appointments com definição inesperada/,
    ],
    [
      'sincronia das ocupações disparando em outra coluna',
      `DROP TRIGGER appointments_sync_occupancies ON app.appointments;
       CREATE TRIGGER appointments_sync_occupancies
         AFTER UPDATE OF version ON app.appointments
         FOR EACH ROW EXECUTE FUNCTION app_private.appointments_sync_occupancies()`,
      /trigger appointments_sync_occupancies em app\.appointments com definição inesperada/,
    ],
    [
      'EXCLUDE anti-overbooking removido',
      'ALTER TABLE app.occupancies DROP CONSTRAINT occupancies_no_staff_overlap',
      /EXCLUDE occupancies_no_staff_overlap em app\.occupancies ausente/,
    ],
    ['dono com LOGIN', 'ALTER ROLE app_migrator LOGIN', /app_migrator precisa ser NOLOGIN/],
    [
      'dono herdando outro papel',
      'GRANT pg_read_all_data TO app_migrator',
      /app_migrator é membro de pg_read_all_data/,
    ],
    [
      'UPDATE de tabela inteira para app_worker',
      'GRANT UPDATE ON app.customers TO app_worker',
      /app\.customers: privilégio UPDATE na tabela inteira/,
    ],
    [
      'DELETE de ocupação para a aplicação',
      'GRANT DELETE ON app.occupancies TO app_user',
      /app\.occupancies: privilégio DELETE \(ocupação não se apaga nem se move\)/,
    ],
    [
      'UPDATE do horário da ocupação para a aplicação',
      'GRANT UPDATE (starts_at) ON app.occupancies TO app_user',
      /app\.occupancies: privilégio UPDATE \(coluna starts_at; só active\)/,
    ],
    [
      'materialized view com dados de tenant legível pela aplicação (sem RLS)',
      `CREATE MATERIALIZED VIEW app.leak AS SELECT * FROM app.customers WITH NO DATA;
       GRANT SELECT ON app.leak TO app_user`,
      /app\.leak: materialized view ou foreign table legível pela aplicação/,
    ],
    [
      'INSERT na auditoria para a aplicação',
      'GRANT INSERT ON app.appointment_events TO app_user',
      /app\.appointment_events: privilégio INSERT/,
    ],
    [
      'DELETE de agendamento para a aplicação',
      'GRANT DELETE ON app.appointments TO app_user',
      /app\.appointments: privilégio DELETE/,
    ],
    [
      'app_worker apagando dados',
      'GRANT DELETE ON app.customers TO app_worker',
      /app\.customers: privilégio DELETE .*app_worker/,
    ],
    [
      'SECURITY DEFINER com search_path sem pg_temp no fim',
      `CREATE FUNCTION app_private.weak_path() RETURNS integer LANGUAGE sql SECURITY DEFINER
         SET search_path = pg_temp, pg_catalog AS 'SELECT 1';
       ALTER FUNCTION app_private.weak_path() OWNER TO app_migrator;
       REVOKE EXECUTE ON FUNCTION app_private.weak_path() FROM PUBLIC`,
      /app_private\.weak_path\(\) \(SECURITY DEFINER\) sem search_path fixo/,
    ],
  ])('assert_security_invariants() detecta sabotagem: %s', async (_label, sabotage, expected) => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(sabotage);
      await client.query('SET LOCAL ROLE app_migrator');
      await expect(client.query('SELECT app_private.assert_security_invariants()')).rejects.toThrow(
        expected,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('appointment_events: auditoria append-only', () => {
  let db: Database;
  let admin: pg.Pool;
  let tenant: TenantFixture;

  beforeAll(async () => {
    db = connectAsAppUser();
    admin = connectAsAdmin();
    tenant = await createTenantFixture(db);
  });

  afterAll(async () => {
    await Promise.all([db.$client.end(), admin.end()]);
  });

  it('app_user lê os eventos do próprio tenant', async () => {
    const events = await withTenant(db, tenant.tenantId, (tx) =>
      tx
        .select()
        .from(appointmentEvents)
        .where(eq(appointmentEvents.appointmentId, tenant.appointmentId)),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'created',
      toStatus: 'confirmed',
      actorType: 'staff',
      actorId: 'fixture',
    });
  });

  it('app_user não consegue UPDATE, DELETE, TRUNCATE nem forjar INSERT', async () => {
    await expect(
      withTenant(db, tenant.tenantId, (tx) =>
        tx
          .update(appointmentEvents)
          .set({ actorId: 'adulterado' })
          .where(eq(appointmentEvents.appointmentId, tenant.appointmentId)),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      withTenant(db, tenant.tenantId, (tx) =>
        tx
          .delete(appointmentEvents)
          .where(eq(appointmentEvents.appointmentId, tenant.appointmentId)),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      withTenant(db, tenant.tenantId, (tx) =>
        tx.insert(appointmentEvents).values({
          appointmentId: tenant.appointmentId,
          eventType: 'status_changed',
          fromStatus: 'confirmed',
          toStatus: 'cancelled_by_salon',
          actorType: 'staff',
        }),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    expect(await captureSqlState(db.$client.query('TRUNCATE app.appointment_events'))).toBe(
      PG_ERROR.insufficientPrivilege,
    );
  });

  it('nem o superusuário altera, apaga ou trunca a trilha (trigger append-only)', async () => {
    const restrictViolation = '23001';
    expect(
      await captureSqlState(
        admin.query("UPDATE app.appointment_events SET actor_id = 'x' WHERE tenant_id = $1", [
          tenant.tenantId,
        ]),
      ),
    ).toBe(restrictViolation);
    expect(
      await captureSqlState(
        admin.query('DELETE FROM app.appointment_events WHERE tenant_id = $1', [tenant.tenantId]),
      ),
    ).toBe(restrictViolation);
    expect(await captureSqlState(admin.query('TRUNCATE app.appointment_events'))).toBe(
      restrictViolation,
    );
  });

  it('mudar status sem contexto de tenant falha até para o superusuário (a auditoria não é pulada)', async () => {
    // O trigger de auditoria roda como app_migrator, sujeito à política RESTRICTIVE: sem
    // app.tenant_id, o evento não pode ser gravado e a transição inteira é desfeita.
    expect(
      await captureSqlState(
        admin.query("UPDATE app.appointments SET status = 'cancelled_by_salon' WHERE id = $1", [
          tenant.appointmentId,
        ]),
      ),
    ).toBe(PG_ERROR.insufficientPrivilege);
    const { rows } = await admin.query<{ status: string }>(
      'SELECT status FROM app.appointments WHERE id = $1',
      [tenant.appointmentId],
    );
    expect(rows[0]?.status).toBe('confirmed');
  });

  it('agendamento com histórico não pode ser apagado (nem pelo dono)', async () => {
    expect(
      await captureSqlState(
        admin.query('DELETE FROM app.appointments WHERE id = $1', [tenant.appointmentId]),
      ),
    ).toBe(PG_ERROR.foreignKeyViolation);
  });
});

describe('o papel da aplicação nunca é o superusuário', () => {
  it('conexão app_user: current_user = app_user, sem superusuário nem BYPASSRLS', async () => {
    const db = connectAsAppUser(1);
    try {
      const { rows } = await db.$client.query(
        `SELECT current_user AS who, r.rolsuper, r.rolbypassrls,
                current_setting('is_superuser') AS is_superuser
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      expect(rows[0]).toEqual({
        who: 'app_user',
        rolsuper: false,
        rolbypassrls: false,
        is_superuser: 'off',
      });
    } finally {
      await db.$client.end();
    }
  });
});
