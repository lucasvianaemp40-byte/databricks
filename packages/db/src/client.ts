import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;

/**
 * Banco tipado com o pool por trás. Só este tipo (e não uma transação) é aceito por
 * `withTenant`: assim não dá para trocar de tenant no meio de uma transação aberta.
 */
export type Database = NodePgDatabase<Schema> & { $client: pg.Pool };

export interface CreateDbOptions {
  /** Conexões máximas do pool (padrão 10). Em serverless, use poucas e um pooler. */
  readonly max?: number;
  /** Tempo ocioso antes de fechar uma conexão (ms, padrão 30 000). */
  readonly idleTimeoutMillis?: number;
  /** Tempo máximo para obter conexão (ms, padrão 10 000). */
  readonly connectionTimeoutMillis?: number;
  /** Aparece em pg_stat_activity (padrão "salon"). */
  readonly applicationName?: string;
  /** Repassado ao node-postgres. Em produção: `{ rejectUnauthorized: true, ca }` ou sslmode na URL. */
  readonly ssl?: pg.PoolConfig['ssl'];
  /**
   * Erros de conexões OCIOSAS do pool (queda de rede, failover). Sem um ouvinte, o
   * node-postgres derrubaria o processo. Padrão: registra no stderr sem expor a URL.
   */
  readonly onPoolError?: (error: Error) => void;
}

const POSTGRES_URL = /^postgres(ql)?:\/\//;

function defaultPoolErrorHandler(error: Error): void {
  console.error('[@salon/db] erro em conexão ociosa do pool PostgreSQL:', error.message);
}

/**
 * Cria o pool e o cliente Drizzle. Em runtime de aplicação, use a URL do papel `app_user`
 * (ou `app_worker`): NUNCA a do superusuário/dono, que ignoraria a RLS.
 * Feche com `await db.$client.end()`.
 */
export function createDb(url: string, options: CreateDbOptions = {}): Database {
  if (!POSTGRES_URL.test(url)) {
    throw new TypeError('createDb: a URL precisa começar com postgres:// ou postgresql://');
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    application_name: options.applicationName ?? 'salon',
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  });
  pool.on('error', options.onPoolError ?? defaultPoolErrorHandler);
  return drizzle({ client: pool, schema });
}
