import { sql } from 'drizzle-orm';
import type { Database } from './client';
import { mapDatabaseError } from './errors';
import { isUuid } from './ids';

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
 * ÚNICA porta de acesso a dados de tenant. Abre uma transação, define o contexto com
 * `set_config(..., true)` (escopo da transação: seguro com pool e com PgBouncer em modo
 * transaction) e executa `fn`. A RLS do banco filtra/recusa tudo que não for do tenant.
 *
 * - O `tenantId` vem SEMPRE da sessão autenticada (membership), nunca do corpo/URL.
 * - Também fixa `TimeZone = UTC` e `DateStyle = ISO` na transação, para que timestamptz
 *   chegue em um formato que o Drizzle converte para `Date` sem ambiguidade.
 * - Erros do banco saem traduzidos (`SlotUnavailableError`, `TenantIsolationError`,
 *   `InvalidStatusTransitionError`, `IdempotencyKeyConflictError`); os demais, inalterados.
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

  try {
    return await db.transaction(
      async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${id}, true),
                     set_config('app.actor_type', ${actor?.type ?? ''}, true),
                     set_config('app.actor_id', ${actor?.id ?? ''}, true),
                     set_config('TimeZone', 'UTC', true),
                     set_config('DateStyle', 'ISO, YMD', true)`,
        );
        return await fn(tx);
      },
      options.readOnly === true ? { accessMode: 'read only' } : undefined,
    );
  } catch (error) {
    throw mapDatabaseError(error);
  }
}
