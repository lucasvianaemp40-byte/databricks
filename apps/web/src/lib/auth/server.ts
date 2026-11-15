/**
 * Instâncias do servidor: Better Auth (papel app_auth, schema auth) e o banco da aplicação
 * (papel app_user, RLS). Criadas no primeiro uso e reaproveitadas (inclusive entre recargas
 * do `next dev`). Falham fechado: sem a configuração, ou com APP_ENV=production enquanto a
 * trava A1 estiver de pé, nada é criado e a chamada lança.
 */
import 'server-only';
import { createDb, type Database } from '@salon/db';
import { betterAuth } from 'better-auth';
import pg from 'pg';
import { env } from '../../env';
import { assertAuthAllowed, buildAuthOptions } from './config';

class AuthNotConfiguredError extends Error {
  readonly code = 'AUTH_NOT_CONFIGURED';

  constructor() {
    super('Banco e autenticação não configurados (veja apps/web/.env.example).');
    this.name = new.target.name;
  }
}

function createAuth(authDatabaseUrl: string, secret: string) {
  const database = new pg.Pool({
    connectionString: authDatabaseUrl,
    max: 5,
    application_name: 'salon-web-auth',
    // As tabelas do Better Auth ficam no schema auth (migração 0006).
    options: '-c search_path=auth',
  });
  // Erro numa conexão OCIOSA (queda, failover) sem ouvinte derrubaria o processo. Sem a URL.
  database.on('error', () => {
    console.error('[auth] conexão ociosa do pool caiu e foi descartada');
  });
  return betterAuth(buildAuthOptions({ baseURL: env.APP_URL, secret, database }));
}

type Auth = ReturnType<typeof createAuth>;

const instances = globalThis as typeof globalThis & {
  __salonAuth?: Auth;
  __salonAppDb?: Database;
};

function configuration() {
  assertAuthAllowed(env.APP_ENV);
  const { DATABASE_URL, AUTH_DATABASE_URL, BETTER_AUTH_SECRET } = env;
  if (
    DATABASE_URL === undefined ||
    AUTH_DATABASE_URL === undefined ||
    BETTER_AUTH_SECRET === undefined
  ) {
    throw new AuthNotConfiguredError();
  }
  return { DATABASE_URL, AUTH_DATABASE_URL, BETTER_AUTH_SECRET };
}

export function getAuth(): Auth {
  const config = configuration();
  instances.__salonAuth ??= createAuth(config.AUTH_DATABASE_URL, config.BETTER_AUTH_SECRET);
  return instances.__salonAuth;
}

/** Banco da aplicação (app_user). Todo acesso a dado de tenant passa por `withTenant`. */
export function getAppDb(): Database {
  const config = configuration();
  instances.__salonAppDb ??= createDb(config.DATABASE_URL, {
    max: 10,
    applicationName: 'salon-web',
  });
  return instances.__salonAppDb;
}
