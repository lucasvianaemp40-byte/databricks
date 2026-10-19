import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import type { Database } from './client';
import { mapDatabaseError, TransactionClosedError, TransactionConflictError } from './errors';
import { isUuid } from './ids';
import * as schema from './schema';

/** Transação recebida pelo callback de `withTenant` (mesma API do `db` do Drizzle). */
export type TenantTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Quem está agindo, registrado na auditoria de transições (`appointment_events`). */
export interface AuditActor {
  readonly type: 'customer' | 'staff' | 'system';
  /** Identificador opaco do ator (id do usuário, do job...). Nunca nome, e-mail ou telefone. */
  readonly id?: string;
}

export interface WithTenantOptions {
  /** Sem ator, os eventos de auditoria ficam com `actor_type = 'unknown'`. */
  readonly actor?: AuditActor;
  /** Abre a transação como READ ONLY (consultas). */
  readonly readOnly?: boolean;
}

const ACTOR_TYPES: ReadonlySet<string> = new Set(['customer', 'staff', 'system']);
// Só caracteres visíveis ASCII: o valor vai para um GUC e para a trilha de auditoria.
const ACTOR_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

/**
 * Valida o id do tenant antes que ele chegue ao banco. Um valor inválido nunca vira
 * `set_config`: a função lança antes de abrir a transação. Devolve o UUID em minúsculas.
 */
export function parseTenantId(tenantId: unknown): string {
  if (!isUuid(tenantId)) {
    throw new TypeError('withTenant: tenantId precisa ser um UUID válido');
  }
  return tenantId.toLowerCase();
}

function parseAuditActor(actor: AuditActor): AuditActor {
  if (!ACTOR_TYPES.has(actor.type)) {
    throw new TypeError('withTenant: actor.type inválido');
  }
  if (actor.id !== undefined && !ACTOR_ID_PATTERN.test(actor.id)) {
    throw new TypeError('withTenant: actor.id precisa ter de 1 a 128 caracteres ASCII visíveis');
  }
  return actor;
}

/**
 * Tentativas ao todo quando o PostgreSQL aborta a transação por deadlock (40P01) ou falha de
 * serialização (40001): a documentação dele manda repetir a transação inteira nesses casos.
 */
const MAX_ATTEMPTS = 3;
/** Teto da espera antes da 2ª tentativa; dobra a cada nova tentativa (jitter total). */
const RETRY_BASE_DELAY_MS = 25;

/** Comandos com que o Drizzle encerra a transação (`sql`commit`` / `sql`rollback``). */
const TRANSACTION_END: ReadonlySet<string> = new Set(['commit', 'rollback']);

interface GuardedConnection {
  /** O que o Drizzle recebe como cliente: só expõe `query`, e só enquanto a transação vive. */
  readonly client: pg.PoolClient;
  /** O callback terminou: daqui em diante só passam o COMMIT/ROLLBACK do próprio Drizzle. */
  finishCallback(): void;
  /** A transação acabou: toda consulta é recusada sem tocar na conexão. */
  close(): void;
  /** A conexão emitiu erro (queda, failover, pg_terminate_backend): nunca volta ao pool. */
  markBroken(): void;
  /** A conexão pode voltar ao pool (transação encerrada, nenhuma consulta pendente, sem erro). */
  reusable(): boolean;
}

/**
 * Embrulha o PoolClient da transação. O `tx` do Drizzle guarda referência direta ao cliente
 * e o node-postgres aceita `query` num cliente já devolvido ao pool: sem esta guarda, uma
 * consulta atrasada rodaria na conexão de outra requisição, com o `app.tenant_id` DELA.
 */
function guardConnection(connection: pg.PoolClient): GuardedConnection {
  let phase: 'open' | 'finishing' | 'closed' = 'open';
  let inFlight = 0;
  let ended = false;
  let broken = false;
  const guarded = {
    query(config: string | pg.QueryConfig, values?: unknown[]): Promise<pg.QueryResult> {
      const text = (typeof config === 'string' ? config : config.text).trim().toLowerCase();
      const ends = TRANSACTION_END.has(text);
      if (phase === 'closed' || (phase === 'finishing' && !ends)) {
        return Promise.reject(new TransactionClosedError());
      }
      inFlight += 1;
      return connection
        .query(config, values)
        .then((result) => {
          ended ||= ends;
          return result;
        })
        .finally(() => {
          inFlight -= 1;
        });
    },
  };
  return {
    client: guarded as unknown as pg.PoolClient,
    finishCallback() {
      if (phase === 'open') {
        phase = 'finishing';
      }
    },
    close() {
      phase = 'closed';
    },
    markBroken() {
      broken = true;
    },
    reusable: () => ended && inFlight === 0 && !broken,
  };
}

/**
 * ÚNICA porta de acesso a dados de tenant. Abre uma transação READ COMMITTED, define o
 * contexto com `set_config(..., true)` (escopo da transação: seguro com pool e com PgBouncer
 * em modo transaction) e executa `fn`. A RLS do banco filtra/recusa tudo que não for do tenant.
 *
 * - O `tenantId` vem SEMPRE da sessão autenticada (membership), nunca do corpo/URL.
 * - O `tx` só vale enquanto `fn` executa. Toda consulta precisa terminar antes de `fn`
 *   resolver: nada de fire-and-forget, `after()` ou builder devolvido para executar depois, e
 *   em `Promise.all` com ramos que podem falhar use `Promise.allSettled` (ou aguarde cada
 *   ramo). Depois do fim, o `tx` recusa tudo com `TransactionClosedError` sem tocar no banco.
 * - Também fixa `TimeZone = UTC` e `DateStyle = ISO` na transação, para que timestamptz
 *   chegue em um formato que o Drizzle converte para `Date` sem ambiguidade.
 * - Erros do banco saem traduzidos (`SlotUnavailableError`, `TenantIsolationError`,
 *   `InvalidStatusTransitionError`, `IdempotencyKeyConflictError`,
 *   `TransactionConflictError`); os demais, inalterados.
 * - Deadlock (40P01) ou falha de serialização (40001): o PostgreSQL abortou a transação para
 *   resolver um conflito com outra. `withTenant` repete a transação inteira, numa conexão
 *   nova, até 3 tentativas com espera aleatória curta; se persistir, lança
 *   `TransactionConflictError`. Por isso `fn` pode rodar mais de uma vez: dentro dela, só
 *   trabalho na transação (nada de e-mail, HTTP ou fila fora do banco).
 * - Recebe o `db` (pool), não uma transação: aninhar `withTenant` exigiria trocar de tenant
 *   no meio de uma transação, o que o tipo `Database` impede.
 */
export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  const id = parseTenantId(tenantId);
  const actor = options.actor === undefined ? undefined : parseAuditActor(options.actor);
  if (!('$client' in db)) {
    throw new TypeError('withTenant: passe o banco (createDb), não uma transação');
  }
  // Nível fixo: o FOR SHARE dos triggers de ocupação só serializa em READ COMMITTED, e o
  // `begin isolation level ...` vence o default_transaction_isolation do banco/papel/URL.
  const config: PgTransactionConfig = {
    isolationLevel: 'read committed',
    ...(options.readOnly === true ? { accessMode: 'read only' as const } : {}),
  };

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runTransaction(db, id, actor, config, fn);
    } catch (error) {
      if (!(error instanceof TransactionConflictError) || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
    }
    // Jitter total: as vítimas do mesmo conflito não voltam todas ao mesmo tempo.
    await delay(randomInt(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + 1));
  }
}

/** Uma tentativa: conexão própria, transação, contexto do tenant, `fn` e erro traduzido. */
async function runTransaction<T>(
  db: Database,
  id: string,
  actor: AuditActor | undefined,
  config: PgTransactionConfig,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  let connection: pg.PoolClient;
  try {
    connection = await db.$client.connect();
  } catch (error) {
    throw mapDatabaseError(error);
  }
  const guard = guardConnection(connection);
  // Emprestada, a conexão fica sem o ouvinte de 'error' do pool (o pg-pool o tira no acquire e
  // o devolve no release). Sem este, uma queda entre consultas (failover, pg_terminate_backend)
  // emitiria 'error' sem ouvinte e derrubaria o processo. O erro em si não se perde: a próxima
  // consulta, ou o COMMIT, falha, e a conexão é destruída no fim.
  const onConnectionError = (): void => {
    guard.markBroken();
  };
  connection.on('error', onConnectionError);
  try {
    return await drizzle({ client: guard.client, schema }).transaction(async (tx) => {
      try {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${id}, true),
                     set_config('app.actor_type', ${actor?.type ?? ''}, true),
                     set_config('app.actor_id', ${actor?.id ?? ''}, true),
                     set_config('TimeZone', 'UTC', true),
                     set_config('DateStyle', 'ISO, YMD', true)`,
        );
        return await fn(tx);
      } finally {
        guard.finishCallback();
      }
    }, config);
  } catch (error) {
    throw mapDatabaseError(error);
  } finally {
    guard.close();
    connection.off('error', onConnectionError);
    // Transação sem desfecho confirmado (BEGIN/COMMIT/ROLLBACK falhou), consulta pendente ou
    // erro na conexão: ela é destruída em vez de voltar ao pool.
    connection.release(
      guard.reusable()
        ? undefined
        : new Error('withTenant: conexão descartada (transação sem desfecho limpo)'),
    );
  }
}
