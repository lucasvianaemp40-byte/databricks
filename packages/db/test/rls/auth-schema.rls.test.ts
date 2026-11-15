import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PG_ERROR } from '../../src/errors';
import { captureSqlState, connectAsAdmin, connectAsAuth } from '../helpers/connections';

/** Tabelas que o Better Auth 1.7 usa com o plugin organization (ADR-0004). */
const AUTH_TABLES = [
  'account',
  'invitation',
  'member',
  'organization',
  'session',
  'user',
  'verification',
] as const;

/**
 * Schema `auth` (Better Auth) e papel `app_auth`. As credenciais (hash de senha, tokens de
 * sessão) ficam num schema que só o `app_auth` acessa; o `app_auth`, por sua vez, não
 * enxerga nada de tenant. Verifica a configuração IMPLANTADA, como os demais meta-testes.
 */
describe('schema auth (Better Auth) e papel app_auth', () => {
  let admin: pg.Pool;

  beforeAll(() => {
    admin = connectAsAdmin();
  });

  afterAll(async () => {
    await admin.end();
  });

  it('app_auth: LOGIN, NOINHERIT, sem SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION e sem herdar papel', async () => {
    const { rows } = await admin.query(`
      SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
             rolinherit, rolcanlogin
        FROM pg_roles WHERE rolname = 'app_auth'`);
    expect(rows).toEqual([
      {
        rolname: 'app_auth',
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolinherit: false,
        rolcanlogin: true,
      },
    ]);
    const { rows: memberships } = await admin.query(`
      SELECT r.rolname AS role FROM pg_roles u CROSS JOIN pg_roles r
       WHERE u.rolname = 'app_auth' AND r.oid <> u.oid AND pg_has_role(u.oid, r.oid, 'MEMBER')`);
    expect(memberships).toEqual([]);
  });

  it('o schema auth e todas as suas tabelas são do app_migrator', async () => {
    const { rows } = await admin.query<{ name: string; owner: string }>(`
      SELECT 'schema auth' AS name, pg_get_userbyid(n.nspowner) AS owner
        FROM pg_namespace n WHERE n.nspname = 'auth'
      UNION ALL
      SELECT c.relname, pg_get_userbyid(c.relowner)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p')
       ORDER BY 1`);
    expect(rows.map((row) => row.name).sort()).toEqual([...AUTH_TABLES, 'schema auth'].sort());
    expect(new Set(rows.map((row) => row.owner))).toEqual(new Set(['app_migrator']));
  });

  it('app_auth tem SELECT/INSERT/UPDATE/DELETE em cada tabela de auth e nenhum privilégio fora de auth', async () => {
    const { rows } = await admin.query<{ rel: string; privileges: string[] }>(`
      SELECT c.oid::regclass::text AS rel,
             array_agg(acl.privilege_type ORDER BY acl.privilege_type) AS privileges
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
       WHERE pg_get_userbyid(acl.grantee) = 'app_auth'
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       GROUP BY 1 ORDER BY 1`);
    const byRel = (a: { rel: string }, b: { rel: string }) => (a.rel < b.rel ? -1 : 1);
    expect([...rows].sort(byRel)).toEqual(
      AUTH_TABLES.map((table) => ({
        rel: table === 'user' ? 'auth."user"' : `auth.${table}`,
        privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      })).sort(byRel),
    );
    const { rows: schemas } = await admin.query<{ nspname: string }>(`
      SELECT n.nspname FROM pg_namespace n
       WHERE has_schema_privilege('app_auth', n.oid, 'USAGE')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
       ORDER BY 1`);
    expect(schemas.map((row) => row.nspname)).toEqual(['auth', 'public']);
  });

  it('app_user, app_worker e PUBLIC não têm nada no schema auth (nem USAGE)', async () => {
    const { rows } = await admin.query(`
      SELECT role, has_schema_privilege(role, 'auth', 'USAGE') AS usage
        FROM unnest(ARRAY['app_user', 'app_worker', 'public']) AS role
       WHERE role <> 'public'
      UNION ALL
      SELECT 'public', EXISTS (
        SELECT FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) AS acl
         WHERE n.nspname = 'auth' AND acl.grantee = 0)
       ORDER BY 1`);
    expect(rows).toEqual([
      { role: 'app_user', usage: false },
      { role: 'app_worker', usage: false },
      { role: 'public', usage: false },
    ]);
    const { rows: grants } = await admin.query(`
      SELECT c.relname, acl.grantee FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
       WHERE n.nspname = 'auth'
         AND (acl.grantee = 0 OR pg_get_userbyid(acl.grantee) IN ('app_user', 'app_worker'))`);
    expect(grants).toEqual([]);
  });

  it('app_auth grava e lê usuários no schema auth, mas não lê dado de tenant (42501)', async () => {
    const auth = connectAsAuth();
    try {
      const { rows } = await auth.query<{ email: string }>(
        `INSERT INTO "user" (name, email, "emailVerified")
         VALUES ('Dona do Salão', 'dona+auth-schema@example.test', false) RETURNING email`,
      );
      expect(rows).toEqual([{ email: 'dona+auth-schema@example.test' }]);
      expect(await captureSqlState(auth.query('SELECT 1 FROM app.customers LIMIT 1'))).toBe(
        PG_ERROR.insufficientPrivilege,
      );
      expect(await captureSqlState(auth.query('SELECT 1 FROM app.tenants LIMIT 1'))).toBe(
        PG_ERROR.insufficientPrivilege,
      );
    } finally {
      await auth.end();
    }
  });

  it('app_user e app_worker não leem credenciais nem sessões (42501 de ponta a ponta)', async () => {
    for (const url of [inject('appUserDatabaseUrl'), inject('appWorkerDatabaseUrl')]) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        for (const table of ['auth.account', 'auth.session', 'auth."user"']) {
          expect(await captureSqlState(client.query(`SELECT 1 FROM ${table} LIMIT 1`)), table).toBe(
            PG_ERROR.insufficientPrivilege,
          );
        }
      } finally {
        await client.end();
      }
    }
  });

  it('app_auth tem search_path=auth no banco (não depende só do cliente)', async () => {
    const { rows } = await admin.query<{ config: string[] }>(`
      SELECT s.setconfig AS config FROM pg_db_role_setting s
        JOIN pg_roles r ON r.oid = s.setrole
        JOIN pg_database d ON d.oid = s.setdatabase
       WHERE r.rolname = 'app_auth' AND d.datname = current_database()`);
    expect(rows).toEqual([{ config: ['search_path=auth'] }]);
  });

  it('um membro por (organização, usuário) e uma conta por (provedor, id): 23505 no repetido', async () => {
    const auth = connectAsAuth();
    try {
      const { rows } = await auth.query<{ user_id: string; org_id: string }>(`
        WITH u AS (
          INSERT INTO "user" (name, email, "emailVerified")
          VALUES ('Membro Único', 'membro+unico@example.test', false) RETURNING id
        ), o AS (
          INSERT INTO organization (name, slug, "createdAt")
          VALUES ('Salão Único', 'salao-unico-auth', now()) RETURNING id
        )
        SELECT u.id AS user_id, o.id AS org_id FROM u, o`);
      const ids = rows[0];
      expect(ids).toBeDefined();
      const member = `INSERT INTO member ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'owner', now())`;
      await auth.query(member, [ids?.org_id, ids?.user_id]);
      expect(await captureSqlState(auth.query(member, [ids?.org_id, ids?.user_id]))).toBe(
        PG_ERROR.uniqueViolation,
      );
      const account = `INSERT INTO account ("accountId", "providerId", "userId", "updatedAt") VALUES ($1::text, 'credential', $2::uuid, now())`;
      await auth.query(account, [ids?.user_id, ids?.user_id]);
      expect(await captureSqlState(auth.query(account, [ids?.user_id, ids?.user_id]))).toBe(
        PG_ERROR.uniqueViolation,
      );
    } finally {
      await auth.end();
    }
  });

  it.each([
    [
      'app_user lendo credenciais',
      'GRANT USAGE ON SCHEMA auth TO app_user; GRANT SELECT ON auth.account TO app_user',
      /auth\.account: privilégio SELECT \(credenciais: só app_auth\) concedido a app_user/,
    ],
    [
      'app_auth lendo dado de tenant',
      'GRANT USAGE ON SCHEMA app TO app_auth; GRANT SELECT ON app.customers TO app_auth',
      /app\.customers: privilégio SELECT \(app_auth: só o schema auth\) concedido a app_auth/,
    ],
    ['app_auth com CREATEDB', 'ALTER ROLE app_auth CREATEDB', /papel app_auth tem CREATEROLE/],
    [
      'app_auth com BYPASSRLS',
      'ALTER ROLE app_auth BYPASSRLS',
      /papel app_auth é SUPERUSER ou BYPASSRLS/,
    ],
    [
      'app_auth herdando outro papel',
      'GRANT app_user TO app_auth',
      /papel app_auth é membro de app_user/,
    ],
    [
      'app_auth com TRUNCATE',
      'GRANT TRUNCATE ON auth.session TO app_auth',
      /auth\.session: privilégio TRUNCATE concedido a app_auth/,
    ],
    [
      'app_user com USAGE no schema auth (mesmo sem GRANT de tabela)',
      'GRANT USAGE ON SCHEMA auth TO app_user',
      /app_user tem USAGE no schema auth/,
    ],
    [
      'PUBLIC com USAGE no schema auth',
      'GRANT USAGE ON SCHEMA auth TO PUBLIC',
      /schema auth: USAGE para PUBLIC/,
    ],
    [
      'app_auth com USAGE no schema app (mesmo sem GRANT de tabela)',
      'GRANT USAGE ON SCHEMA app TO app_auth',
      /app_auth tem USAGE no schema app/,
    ],
    [
      'tabela de auth de outro dono',
      'CREATE TABLE auth.leak (id int); ALTER TABLE auth.leak OWNER TO app_auth',
      /auth\.leak pertence a app_auth/,
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
