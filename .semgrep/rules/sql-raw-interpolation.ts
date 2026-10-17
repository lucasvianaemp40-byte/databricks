// Fixture de `semgrep --test` para sql-raw-interpolation. Código vulnerável de propósito.
import { sql } from 'drizzle-orm';

declare const db: {
  execute: (query: unknown) => Promise<unknown>;
};
declare const client: {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  escapeIdentifier: (value: string) => string;
  escapeLiteral: (value: string) => string;
};
declare const customerId: string;
declare const databaseName: string;
declare const orderBy: string;
declare const lockTimeoutMs: number;
const BOOKKEEPING_TABLE = 'drizzle.__drizzle_migrations';

export async function examples(): Promise<void> {
  // ruleid: sql-raw-interpolation
  await db.execute(sql.raw(`select * from app.customers where id = '${customerId}'`));

  // ruleid: sql-raw-interpolation
  await db.execute(sql`select * from app.customers order by ${sql.raw(orderBy)}`);

  // ruleid: sql-raw-interpolation
  await client.query(`select * from app.customers where id = '${customerId}'`);

  // ruleid: sql-raw-interpolation
  await client.query("select * from app.customers where id = '" + customerId + "'");

  // ruleid: sql-raw-interpolation
  await db.execute(`delete from app.customers where id = '${customerId}'`);

  // ok: sql-raw-interpolation
  await db.execute(sql`select * from app.customers where id = ${customerId}`);

  // ok: sql-raw-interpolation
  await db.execute(sql.raw('select 1'));

  // ok: sql-raw-interpolation
  await client.query('select * from app.customers where id = $1', [customerId]);

  // ok: sql-raw-interpolation
  await client.query(`CREATE DATABASE ${client.escapeIdentifier(databaseName)}`);

  // ok: sql-raw-interpolation
  await client.query(`select ${client.escapeLiteral(customerId)}::uuid`);

  // ok: sql-raw-interpolation
  await client.query(`INSERT INTO ${BOOKKEEPING_TABLE} (hash) VALUES ($1)`, [customerId]);

  // ruleid: sql-raw-interpolation
  await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);

  // ok: sql-raw-interpolation
  await client.query("select set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
}
