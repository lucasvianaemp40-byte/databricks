#!/usr/bin/env node
/**
 * Roda um comando (o Playwright) com um banco descartável e as variáveis do app:
 *
 *   1. cria um banco vazio no cluster de TEST_DATABASE_URL (superusuário de TESTE, nunca
 *      produção: vem do CI ou de scripts/with-local-postgres.sh);
 *   2. aplica as migrações com o runner de produção (`pnpm --filter @salon/db migrate`);
 *   3. define senhas aleatórias para app_user e app_auth;
 *   4. executa o comando com DATABASE_URL (app_user), AUTH_DATABASE_URL (app_auth) e um
 *      BETTER_AUTH_SECRET aleatório. O comando NÃO recebe a URL de superusuário;
 *   5. apaga o banco ao sair, inclusive em falha.
 *
 * Uso: node scripts/with-e2e-database.mjs <comando> [args...]
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const { TEST_DATABASE_URL: maintenanceUrl } = process.env;
const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error('uso: node scripts/with-e2e-database.mjs <comando> [args...]');
  process.exit(64);
}
if (maintenanceUrl === undefined || maintenanceUrl === '') {
  console.error(
    '[e2e] TEST_DATABASE_URL ausente: rode `pnpm e2e` (sobe um PostgreSQL efêmero) ou exporte a URL de um superusuário de um cluster de TESTE.',
  );
  process.exit(69);
}

/** @param {string} url @param {(client: pg.Client) => Promise<unknown>} fn */
async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url, application_name: 'salon-e2e-setup' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** @param {string} url @param {{ database?: string, user?: string, password?: string }} parts */
function rewriteUrl(url, parts) {
  const parsed = new URL(url);
  if (parts.database !== undefined) parsed.pathname = `/${parts.database}`;
  if (parts.user !== undefined) parsed.username = encodeURIComponent(parts.user);
  if (parts.password !== undefined) parsed.password = encodeURIComponent(parts.password);
  return parsed.toString();
}

const database = `salon_e2e_${randomBytes(6).toString('hex')}`;
await withClient(maintenanceUrl, (client) =>
  client.query(`CREATE DATABASE ${client.escapeIdentifier(database)}`),
);
const adminUrl = rewriteUrl(maintenanceUrl, { database });

/** @type {number} */
let exitCode;
try {
  const migrate = spawnSync('pnpm', ['--filter', '@salon/db', 'migrate'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL_MIGRATOR: adminUrl },
  });
  if (migrate.status !== 0) {
    throw new Error('[e2e] as migrações falharam');
  }

  const passwords = {
    app_user: randomBytes(24).toString('hex'),
    app_auth: randomBytes(24).toString('hex'),
  };
  await withClient(adminUrl, async (client) => {
    for (const [role, password] of Object.entries(passwords)) {
      // DDL não aceita parâmetro: format(%I, %L) faz o escape no próprio PostgreSQL.
      const { rows } = await client.query('SELECT format($1, $2::text, $3::text) AS sql', [
        'ALTER ROLE %I PASSWORD %L',
        role,
        password,
      ]);
      await client.query(rows[0].sql);
    }
  });

  const env = { ...process.env };
  // Menor privilégio: o app e o Playwright não recebem a URL de superusuário.
  delete env.TEST_DATABASE_URL;
  delete env.DATABASE_URL_MIGRATOR;
  env.DATABASE_URL = rewriteUrl(adminUrl, { user: 'app_user', password: passwords.app_user });
  env.AUTH_DATABASE_URL = rewriteUrl(adminUrl, { user: 'app_auth', password: passwords.app_auth });
  env.BETTER_AUTH_SECRET = randomBytes(32).toString('base64url');

  exitCode = await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
    child.on('error', () => resolve(1));
  });
} finally {
  await withClient(maintenanceUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(database)} WITH (FORCE)`),
  );
}
process.exit(exitCode);
