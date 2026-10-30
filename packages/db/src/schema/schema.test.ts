import { readdirSync, readFileSync } from 'node:fs';
import * as drizzleKitApi from 'drizzle-kit/api';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { matchesPattern, sqlStringList } from './columns';
import * as schema from './index';

/**
 * Os tipos de drizzle-kit/api importam `zod`, que não é dependência do drizzle-kit: os .d.ts
 * ficam sem resolução (any). Fachada tipada apenas com o que este teste usa.
 */
interface Snapshot {
  readonly id: string;
}
interface DrizzleKitApi {
  generateDrizzleJson(
    imports: Record<string, unknown>,
    prevId?: string,
    schemaFilters?: string[],
  ): Snapshot;
  generateMigration(previous: Snapshot, current: Snapshot): Promise<string[]>;
}
const { generateDrizzleJson, generateMigration } = drizzleKitApi as unknown as DrizzleKitApi;

const metaFolder = new URL('../../drizzle/meta/', import.meta.url);

function latestSnapshot(): Snapshot {
  const snapshots = readdirSync(metaFolder)
    .filter((file) => file.endsWith('_snapshot.json'))
    .sort();
  const latest = snapshots.at(-1);
  if (latest === undefined) {
    throw new Error('nenhum snapshot do drizzle-kit encontrado');
  }
  return JSON.parse(readFileSync(new URL(latest, metaFolder), 'utf8')) as Snapshot;
}

const allTables: PgTable[] = Object.values(schema as Record<string, unknown>).flatMap((value) =>
  is(value, PgTable) ? [value] : [],
);
/** Tabelas de tenant (schema `app`, com RLS). */
const tables = allTables.filter((table) => getTableConfig(table).schema === 'app');
/** Tabelas do Better Auth (schema `auth`, globais, só para o papel `app_auth`). */
const authTables = allTables.filter((table) => getTableConfig(table).schema === 'auth');

describe('schema Drizzle', () => {
  it('não divergiu das migrações: gerar agora não produz nenhum comando', async () => {
    const previous = latestSnapshot();
    const current = generateDrizzleJson(schema, previous.id, ['app', 'auth']);
    // Se falhar: rode `pnpm --filter @salon/db generate --name=<descricao>` e revise o SQL.
    expect(await generateMigration(previous, current)).toEqual([]);
  });

  it('as tabelas ficam só nos schemas app (12, de tenant) e auth (7, do Better Auth)', () => {
    expect(tables.length).toBe(12);
    expect(authTables.map((table) => getTableConfig(table).name).sort()).toEqual([
      'accounts',
      'members',
      'organizations',
      'rate_limits',
      'sessions',
      'users',
      'verifications',
    ]);
    expect(allTables.length).toBe(tables.length + authTables.length);
  });

  it('nenhuma tabela do schema auth tem tenant_id; PK uuid "id" gerada pelo banco (fora organizations)', () => {
    for (const table of authTables) {
      const config = getTableConfig(table);
      const id = config.columns.find((column) => column.name === 'id');
      expect(
        config.columns.map((column) => column.name),
        config.name,
      ).not.toContain('tenant_id');
      expect(id?.primary, config.name).toBe(true);
      expect(id?.getSQLType(), config.name).toBe('uuid');
      // O Better Auth 1.7 (generateId 'uuid' no PostgreSQL) não envia o id: o banco gera.
      // A organização é a exceção: o id é o do tenant, sempre explícito (FK para app.tenants).
      expect(id?.hasDefault, config.name).toBe(config.name !== 'organizations');
    }
  });

  it('a organização do Better Auth aponta para app.tenants pelo próprio id (mesmo id do tenant)', () => {
    const fk = getTableConfig(schema.authOrganizations).foreignKeys.map((key) => key.reference());
    expect(fk).toHaveLength(1);
    expect(fk[0]?.columns.map((column) => column.name)).toEqual(['id']);
    expect(fk[0]?.foreignTable).toBe(schema.tenants);
    expect(fk[0]?.foreignColumns.map((column) => column.name)).toEqual(['id']);
  });

  it('toda tabela, exceto tenants, tem tenant_id NOT NULL com default do contexto', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      if (config.name === 'tenants') {
        continue;
      }
      const tenantId = config.columns.find((column) => column.name === 'tenant_id');
      expect(tenantId?.notNull, config.name).toBe(true);
      expect(tenantId?.hasDefault, config.name).toBe(true);
    }
  });

  it('toda tabela tem PK uuid "id" e created_at; só a auditoria (append-only) não tem updated_at', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      const names = config.columns.map((column) => column.name);
      const id = config.columns.find((column) => column.name === 'id');
      expect(id?.primary, config.name).toBe(true);
      expect(id?.getSQLType(), config.name).toBe('uuid');
      expect(names, config.name).toContain('created_at');
      expect(names.includes('updated_at'), config.name).toBe(config.name !== 'appointment_events');
    }
  });
});

describe('helpers de DDL', () => {
  it('sqlStringList só aceita identificadores simples', () => {
    expect(() => sqlStringList([])).toThrow();
    expect(() => sqlStringList(["x'); DROP TABLE y; --"])).toThrow();
    expect(() => sqlStringList(['Maiuscula'])).toThrow();
  });

  it('matchesPattern recusa regex com aspas simples', () => {
    expect(() => matchesPattern(schema.customers.email, "^a'$")).toThrow();
  });
});
