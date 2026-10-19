// Fixture de `semgrep --test` para sql-string-taint. Código vulnerável de propósito.
import { sql } from 'drizzle-orm';

declare const db: {
  execute: (query: unknown) => Promise<unknown>;
};
declare const client: {
  query: (config: unknown, values?: unknown[]) => Promise<unknown>;
  escapeIdentifier: (value: string) => string;
  escapeLiteral: (value: string) => string;
};
declare const pool: { query: (text: string, values?: unknown[]) => Promise<unknown> };
declare const customerId: string;
declare const prefix: string;
declare const lockTimeoutMs: number;
const BOOKKEEPING_TABLE = 'drizzle.__drizzle_migrations';

// SQL montado numa variável antes de chegar ao driver.
export async function viaVariable(): Promise<void> {
  const byId = `select * from app.customers where id = '${customerId}'`;
  // ruleid: sql-string-taint
  await client.query(byId);

  const byConcat = "select * from app.customers where id = '" + customerId + "'";
  // ruleid: sql-string-taint
  await pool.query(byConcat);

  let filtered = 'select * from app.customers';
  filtered += ` where id = '${customerId}'`;
  // ruleid: sql-string-taint
  await client.query(filtered);

  const timeout = `SET LOCAL lock_timeout = ${lockTimeoutMs}`;
  // ruleid: sql-string-taint
  await client.query({ text: timeout });

  const deletion = `delete from app.customers where id = '${customerId}'`;
  // ruleid: sql-string-taint
  await db.execute(deletion);
}

export async function safe(): Promise<void> {
  // Tagged template do Drizzle: cada ${} vira parâmetro.
  const drizzleQuery = sql`select * from app.customers where id = ${customerId}`;
  // ok: sql-string-taint
  await db.execute(drizzleQuery);

  // Identificador montado por template, mas escapado pelo driver antes de entrar no SQL.
  const name = `${prefix}_scratch`;
  const create = `CREATE DATABASE ${client.escapeIdentifier(name)}`;
  // ok: sql-string-taint
  await client.query(create);

  // Texto fixo em variável; o valor vai no array de parâmetros.
  const parameterized = 'select * from app.customers where id = $1';
  // ok: sql-string-taint
  await client.query(parameterized, [customerId]);

  // ok: sql-string-taint
  await client.query({ text: parameterized, values: [customerId] });

  // Constante de módulo em CAIXA_ALTA.
  const insert = `INSERT INTO ${BOOKKEEPING_TABLE} (hash) VALUES ($1)`;
  // ok: sql-string-taint
  await client.query(insert, [customerId]);

  // Valor interpolado vai nos parâmetros, não no texto da consulta.
  const lockTimeout = `${lockTimeoutMs}ms`;
  // ok: sql-string-taint
  await client.query("select set_config('lock_timeout', $1, true)", [lockTimeout]);
}

// Escritos direto na chamada: são acusados por sql-raw-interpolation; esta regra não duplica.
export async function reportedBySiblingRule(): Promise<void> {
  // ok: sql-string-taint
  await client.query(`select * from app.customers where id = '${customerId}'`);

  // ok: sql-string-taint
  await client.query({ text: `select * from app.customers where id = '${customerId}'` });

  const order = `order by ${prefix}`;
  // ok: sql-string-taint
  await db.execute(sql.raw(order));
}
