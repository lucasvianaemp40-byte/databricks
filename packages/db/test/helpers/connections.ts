import pg from 'pg';
import { inject } from 'vitest';
import { createDb, type Database } from '../../src/client';
import { findPostgresError } from '../../src/errors';

/** Banco como app_user (papel das requisições web). Feche com `db.$client.end()`. */
export function connectAsAppUser(max = 4): Database {
  return createDb(inject('appUserDatabaseUrl'), { max, applicationName: 'salon-test-app' });
}

/** Banco como app_worker (papel dos jobs). */
export function connectAsWorker(max = 2): Database {
  return createDb(inject('appWorkerDatabaseUrl'), { max, applicationName: 'salon-test-worker' });
}

/** Pool de superusuário do banco de teste: catálogo e operações fora da aplicação. */
export function connectAsAdmin(max = 2): pg.Pool {
  return new pg.Pool({
    connectionString: inject('adminDatabaseUrl'),
    max,
    application_name: 'salon-test-admin',
  });
}

/** SQLSTATE do erro (atravessa o embrulho do Drizzle); `undefined` se não veio do banco. */
export function sqlStateOf(error: unknown): string | undefined {
  return findPostgresError(error)?.code;
}

/** Executa e devolve o SQLSTATE do erro esperado; falha se a promessa resolver. */
export async function captureSqlState(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation;
  } catch (error) {
    return sqlStateOf(error);
  }
  throw new Error('esperava um erro do banco, mas a operação foi concluída');
}

/** Tabelas com coluna tenant_id (descobertas no catálogo: tabela nova entra sozinha). */
export async function listTenantTables(admin: pg.Pool): Promise<string[]> {
  const { rows } = await admin.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
        AND EXISTS (SELECT FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                       AND a.attnum > 0 AND NOT a.attisdropped)
      ORDER BY c.relname`,
  );
  return rows.map((row) => row.relname);
}
