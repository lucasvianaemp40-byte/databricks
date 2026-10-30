/**
 * Roda um comando (o `playwright test`) com um banco de E2E pronto:
 *
 *   tsx scripts/with-e2e-database.ts <comando> [args...]
 *
 * 1. cria um banco descartável no cluster de TEST_DATABASE_URL (superusuário de um cluster de
 *    TESTE: o `scripts/with-local-postgres.sh` da raiz sobe um efêmero, o CI usa um serviço);
 * 2. aplica as migrações com o runner de produção (`@salon/db/migrate`);
 * 3. define senhas aleatórias para app_user e app_auth (papéis são do cluster) e exporta
 *    DATABASE_URL, DATABASE_URL_AUTH, BETTER_AUTH_SECRET (aleatório) e MAIL_OUTBOX_DIR (pasta
 *    temporária 0700) para o comando, que os repassa ao webServer;
 * 4. ao sair, apaga o banco e o outbox (também em erro ou Ctrl-C).
 *
 * Com E2E_BASE_URL (ambiente remoto), não há banco local: só executa o comando.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '@salon/db/migrate';
import pg from 'pg';

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

async function admin<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: 'salon-e2e-admin' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    console.error('uso: tsx scripts/with-e2e-database.ts <comando> [args...]');
    return 64;
  }
  if (process.env['E2E_BASE_URL'] !== undefined) {
    return run(command, args, process.env);
  }
  const maintenanceUrl = process.env['TEST_DATABASE_URL'];
  if (maintenanceUrl === undefined || maintenanceUrl === '') {
    console.error(
      'TEST_DATABASE_URL ausente. Rode `pnpm e2e` pela raiz (sobe um PostgreSQL efêmero com ' +
        'scripts/with-local-postgres.sh) ou exporte a URL do superusuário de um cluster de TESTE.',
    );
    return 69;
  }

  const database = `salon_e2e_${randomBytes(6).toString('hex')}`;
  if (!DATABASE_NAME.test(database)) {
    throw new Error('nome de banco inválido');
  }
  const outbox = await mkdtemp(join(tmpdir(), 'salon-e2e-outbox-'));
  await admin(maintenanceUrl, (client) =>
    client.query(`CREATE DATABASE ${client.escapeIdentifier(database)}`),
  );
  const adminUrl = withDatabase(maintenanceUrl, database);
  try {
    await runMigrations({ databaseUrl: adminUrl });
    const passwords = {
      app_user: randomBytes(24).toString('hex'),
      app_auth: randomBytes(24).toString('hex'),
    };
    await admin(adminUrl, async (client) => {
      for (const [role, password] of Object.entries(passwords)) {
        await client.query(
          `ALTER ROLE ${client.escapeIdentifier(role)} PASSWORD ${client.escapeLiteral(password)}`,
        );
      }
    });
    console.error(`[e2e] banco ${database} migrado; outbox em ${outbox}`);
    return await run(command, args, {
      ...process.env,
      DATABASE_URL: withCredentials(adminUrl, 'app_user', passwords.app_user),
      DATABASE_URL_AUTH: withCredentials(adminUrl, 'app_auth', passwords.app_auth),
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
      MAIL_OUTBOX_DIR: outbox,
      // Só para os specs que conferem o banco depois do fluxo (sessão apagada no logout).
      E2E_ADMIN_DATABASE_URL: adminUrl,
    });
  } finally {
    await admin(maintenanceUrl, (client) =>
      client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(database)} WITH (FORCE)`),
    ).catch((error: unknown) => {
      console.error('[e2e] não foi possível apagar o banco descartável:', (error as Error).message);
    });
    await rm(outbox, { recursive: true, force: true });
  }
}

process.exitCode = await main();
