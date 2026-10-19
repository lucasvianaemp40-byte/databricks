import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, inject, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_FOLDER,
  loadMigrations,
  MigrationError,
  MigrationIntegrityError,
  runMigrations,
} from '../../src/migrate';
import { createScratchDatabase, dropDatabase, withDatabase } from '../helpers/database-admin';

const EXPECTED_TAGS = [
  '0000_bootstrap_roles_extensions',
  '0001_private_functions',
  '0002_schema',
  '0003_tenant_security',
];

interface Journal {
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
}

describe('runner de migrações', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  async function scratchDatabase(): Promise<string> {
    const maintenanceUrl = inject('maintenanceDatabaseUrl');
    const name = await createScratchDatabase(maintenanceUrl, 'salon_migrate');
    cleanups.push(() => dropDatabase(maintenanceUrl, name));
    return withDatabase(maintenanceUrl, name);
  }

  /** Cópia descartável da pasta de migrações, para simular edições e migrações novas. */
  function copyMigrations(): string {
    const folder = mkdtempSync(join(tmpdir(), 'salon-migrations-'));
    cpSync(DEFAULT_MIGRATIONS_FOLDER, folder, { recursive: true });
    cleanups.push(() => {
      rmSync(folder, { recursive: true, force: true });
    });
    return folder;
  }

  function addMigration(folder: string, tag: string, when: number, content: string): void {
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
    journal.entries.push({
      idx: journal.entries.length,
      version: '7',
      when,
      tag,
      breakpoints: true,
    });
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    writeFileSync(join(folder, `${tag}.sql`), content);
  }

  async function query<T extends pg.QueryResultRow>(url: string, text: string): Promise<T[]> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return (await client.query<T>(text)).rows;
    } finally {
      await client.end();
    }
  }

  const lastWhen = () => Math.max(...loadMigrations().map((migration) => migration.when));

  it('banco novo: aplica tudo em ordem; segunda execução é no-op', async () => {
    const url = await scratchDatabase();
    const firstRun = await runMigrations({ databaseUrl: url });
    expect(firstRun).toEqual({ applied: EXPECTED_TAGS, alreadyApplied: 0 });

    const secondRun = await runMigrations({ databaseUrl: url });
    expect(secondRun).toEqual({ applied: [], alreadyApplied: EXPECTED_TAGS.length });

    const bookkeeping = await query<{ hash: string; created_at: string }>(
      url,
      'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
    );
    expect(bookkeeping).toEqual(
      loadMigrations().map((migration) => ({
        hash: migration.hash,
        created_at: String(migration.when),
      })),
    );
    const owners = await query<{ owner: string }>(
      url,
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('app', 'app_private') AND c.relkind IN ('r', 'p', 'i')`,
    );
    expect(owners).toEqual([{ owner: 'app_migrator' }]);
  });

  it('dois runners simultâneos no mesmo banco: o advisory lock serializa (aplica uma vez só)', async () => {
    const url = await scratchDatabase();
    const results = await Promise.all([
      runMigrations({ databaseUrl: url }),
      runMigrations({ databaseUrl: url }),
    ]);
    const appliedCounts = results.map((result) => result.applied.length).sort();
    expect(appliedCounts).toEqual([0, EXPECTED_TAGS.length]);
  });

  it('recusa migração já aplicada que foi alterada (imutabilidade)', async () => {
    const url = await scratchDatabase();
    await runMigrations({ databaseUrl: url });
    const folder = copyMigrations();
    appendFileSync(join(folder, '0003_tenant_security.sql'), '\n-- edição depois do deploy\n');
    const run = runMigrations({ databaseUrl: url, migrationsFolder: folder });
    await expect(run).rejects.toBeInstanceOf(MigrationIntegrityError);
    await expect(run).rejects.toThrow(/0003_tenant_security foi alterada/);
  });

  it('recusa quando o banco tem migração que não existe no repositório (código atrás do banco)', async () => {
    const url = await scratchDatabase();
    await runMigrations({ databaseUrl: url });
    const folder = copyMigrations();
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
    journal.entries.pop();
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    await expect(runMigrations({ databaseUrl: url, migrationsFolder: folder })).rejects.toThrow(
      /não existe no repositório/,
    );
  });

  it('recusa migração nova com timestamp anterior à última aplicada (o Drizzle a pularia)', async () => {
    const url = await scratchDatabase();
    await runMigrations({ databaseUrl: url });
    const folder = copyMigrations();
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
    // Simula um merge: a migração do outro branch foi gerada antes da 0003.
    const third = journal.entries[3];
    const second = journal.entries[2];
    if (third === undefined || second === undefined) {
      throw new Error('journal inesperado');
    }
    journal.entries.splice(3, 0, {
      idx: 3,
      version: '7',
      when: second.when + 1,
      tag: '0003_from_other_branch',
      breakpoints: true,
    });
    third.idx = 4;
    third.tag = '0003_tenant_security';
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    writeFileSync(join(folder, '0003_from_other_branch.sql'), 'SELECT 1;');
    await expect(runMigrations({ databaseUrl: url, migrationsFolder: folder })).rejects.toThrow(
      /timestamp anterior à última aplicada: 0003_from_other_branch/,
    );
  });

  it('migração nova roda como app_migrator e o objeto criado é dele', async () => {
    const url = await scratchDatabase();
    await runMigrations({ databaseUrl: url });
    const folder = copyMigrations();
    addMigration(
      folder,
      '0004_probe_owner',
      lastWhen() + 1000,
      `CREATE TABLE app.probe (id int PRIMARY KEY, created_by text DEFAULT current_user);
--> statement-breakpoint
ALTER TABLE app.probe ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.probe FORCE ROW LEVEL SECURITY;`,
    );
    const result = await runMigrations({ databaseUrl: url, migrationsFolder: folder });
    expect(result.applied).toEqual(['0004_probe_owner']);
    const rows = await query<{ owner: string }>(
      url,
      "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'app.probe'::regclass",
    );
    expect(rows).toEqual([{ owner: 'app_migrator' }]);
  });

  it('migração que cria tabela de tenant SEM RLS é revertida pela verificação de invariantes', async () => {
    const url = await scratchDatabase();
    await runMigrations({ databaseUrl: url });
    const folder = copyMigrations();
    addMigration(
      folder,
      '0004_forgot_rls',
      lastWhen() + 1000,
      'CREATE TABLE app.gift_cards (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, balance_cents integer NOT NULL);',
    );
    const run = runMigrations({ databaseUrl: url, migrationsFolder: folder });
    await expect(run).rejects.toBeInstanceOf(MigrationError);
    await expect(run).rejects.toThrow(/app\.gift_cards: RLS desabilitada/);

    const leftovers = await query<{ table: string | null; applied: number }>(
      url,
      `SELECT to_regclass('app.gift_cards')::text AS table,
              (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS applied`,
    );
    expect(leftovers).toEqual([{ table: null, applied: EXPECTED_TAGS.length }]);
  });

  async function migratedWith(extra: readonly (readonly [string, string])[]): Promise<{
    url: string;
    run: Promise<unknown>;
  }> {
    const url = await scratchDatabase();
    await runMigrations({ databaseUrl: url });
    const folder = copyMigrations();
    extra.forEach(([tag, content], index) => {
      addMigration(folder, tag, lastWhen() + 1000 * (index + 1), content);
    });
    return { url, run: runMigrations({ databaseUrl: url, migrationsFolder: folder }) };
  }

  async function historyAndGuard(url: string) {
    return query<{ applied: number; guard: boolean }>(
      url,
      `SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS applied,
              EXISTS (SELECT FROM pg_policy WHERE polrelid = 'app.customers'::regclass
                         AND polname = 'tenant_isolation') AS guard`,
    );
  }

  it('migração que apaga a função de invariantes (e a política de tenant) é revertida: falha fechada', async () => {
    const { url, run } = await migratedWith([
      [
        '0004_sabotage',
        `DROP FUNCTION app_private.assert_security_invariants();
--> statement-breakpoint
DROP POLICY tenant_isolation ON app.customers;`,
      ],
    ]);
    await expect(run).rejects.toBeInstanceOf(MigrationError);
    await expect(run).rejects.toThrow(/função de invariantes .*ausente/);
    expect(await historyAndGuard(url)).toEqual([{ applied: EXPECTED_TAGS.length, guard: true }]);
  });

  it('migração que troca o corpo da função de invariantes é revertida (hash do corpo)', async () => {
    const { url, run } = await migratedWith([
      [
        '0004_sabotage',
        `CREATE OR REPLACE FUNCTION app_private.assert_security_invariants() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN END $$;
--> statement-breakpoint
DROP POLICY tenant_isolation ON app.customers;`,
      ],
    ]);
    await expect(run).rejects.toThrow(/função de invariantes .*foi alterada/);
    expect(await historyAndGuard(url)).toEqual([{ applied: EXPECTED_TAGS.length, guard: true }]);
  });

  it('renomear a função de invariantes não desliga o portão para a migração seguinte', async () => {
    const { url, run } = await migratedWith([
      [
        '0004_rename',
        'ALTER FUNCTION app_private.assert_security_invariants() RENAME TO old_invariants;',
      ],
      [
        '0005_forgot_rls',
        'CREATE TABLE app.gift_cards (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);',
      ],
    ]);
    await expect(run).rejects.toThrow(/função de invariantes .*ausente/);
    const leftovers = await query<{ table: string | null }>(
      url,
      "SELECT to_regclass('app.gift_cards')::text AS table",
    );
    expect(leftovers).toEqual([{ table: null }]);
  });

  describe('papel dono (app_migrator) é do cluster', () => {
    const adminQuery = (text: string) => query(inject('maintenanceDatabaseUrl'), text);

    afterEach(async () => {
      await adminQuery('ALTER ROLE app_migrator NOLOGIN NOINHERIT PASSWORD NULL');
    });

    it('bootstrap corrige app_migrator reaproveitado com LOGIN, INHERIT e senha', async () => {
      await adminQuery("ALTER ROLE app_migrator LOGIN INHERIT PASSWORD 'senha-de-teste'");
      const url = await scratchDatabase();
      await runMigrations({ databaseUrl: url });
      const roles = await query<{ login: boolean; inherit: boolean; password: boolean }>(
        url,
        `SELECT rolcanlogin AS login, rolinherit AS inherit, rolpassword IS NOT NULL AS password
           FROM pg_authid WHERE rolname = 'app_migrator'`,
      );
      expect(roles).toEqual([{ login: false, inherit: false, password: false }]);
    });

    it('dono com LOGIN depois do deploy: a próxima execução do runner falha', async () => {
      const url = await scratchDatabase();
      await runMigrations({ databaseUrl: url });
      await adminQuery('ALTER ROLE app_migrator LOGIN');
      await expect(runMigrations({ databaseUrl: url })).rejects.toThrow(/app_migrator/);
    });
  });

  it('erro de SQL identifica a migração e o comando, e desfaz a execução inteira', async () => {
    const url = await scratchDatabase();
    const folder = copyMigrations();
    addMigration(
      folder,
      '0004_broken',
      lastWhen() + 1000,
      'SELECT 1;\n--> statement-breakpoint\nSELEC 2;',
    );
    await expect(runMigrations({ databaseUrl: url, migrationsFolder: folder })).rejects.toThrow(
      /falha ao aplicar 0004_broken \(comando 2\/2\)/,
    );
    const rows = await query<{ schema: string | null }>(
      url,
      "SELECT to_regnamespace('app')::text AS schema",
    );
    expect(rows).toEqual([{ schema: null }]);
  });
});
