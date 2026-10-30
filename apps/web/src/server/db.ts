import 'server-only';
import { createDb, type Database } from '@salon/db';
import { serverEnv } from './env';

/**
 * Pools do servidor, criados no primeiro uso (o `next build` não abre conexão). Guardados no
 * `globalThis` para o recarregamento do `next dev` não abrir um pool novo a cada edição.
 *
 * - `appDb()`: papel `app_user`, dados de tenant SÓ por `withTenant` (RLS).
 * - `authDb()`: papel `app_auth`, Better Auth, vínculos e `provisionTenant`.
 */
interface Pools {
  app?: Database;
  auth?: Database;
}

const holder = globalThis as { __salonPools?: Pools };
holder.__salonPools ??= {};
const pools: Pools = holder.__salonPools;

export function appDb(): Database {
  pools.app ??= createDb(serverEnv().databaseUrl, { applicationName: 'salon-web', max: 10 });
  return pools.app;
}

export function authDb(): Database {
  pools.auth ??= createDb(serverEnv().databaseUrlAuth, {
    applicationName: 'salon-web-auth',
    max: 5,
  });
  return pools.auth;
}
