import { randomBytes } from 'node:crypto';
import pg from 'pg';

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Troca o banco de uma URL PostgreSQL. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Troca usuário e senha de uma URL PostgreSQL. */
export function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

export function randomSecret(): string {
  return randomBytes(24).toString('hex');
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: 'salon-test-admin' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Cria um banco vazio com nome aleatório (`<prefixo>_<hex>`) e devolve o nome. */
export async function createScratchDatabase(
  maintenanceUrl: string,
  prefix: string,
): Promise<string> {
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  if (!DATABASE_NAME.test(name)) {
    throw new Error(`nome de banco inválido: ${name}`);
  }
  await withClient(maintenanceUrl, (client) =>
    client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`),
  );
  return name;
}

export async function dropDatabase(maintenanceUrl: string, name: string): Promise<void> {
  if (!DATABASE_NAME.test(name)) {
    throw new Error(`nome de banco inválido: ${name}`);
  }
  await withClient(maintenanceUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`),
  );
}

/**
 * Define a senha de um papel de LOGIN (papéis são do cluster, não do banco). Só para o
 * cluster de TESTE: nunca aponte TEST_DATABASE_URL para um servidor compartilhado.
 */
export async function setRolePassword(
  adminUrl: string,
  role: string,
  password: string,
): Promise<void> {
  await withClient(adminUrl, (client) =>
    client.query(
      `ALTER ROLE ${client.escapeIdentifier(role)} PASSWORD ${client.escapeLiteral(password)}`,
    ),
  );
}
