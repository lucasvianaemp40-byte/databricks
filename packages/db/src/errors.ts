/**
 * Tradução de erros do PostgreSQL para erros de domínio da camada de dados.
 *
 * O node-postgres expõe o SQLSTATE em `code` e o nome da constraint em `constraint`; o
 * Drizzle 0.45 embrulha o erro original em `DrizzleQueryError` (com `cause`). Por isso a
 * busca percorre a cadeia de `cause`.
 *
 * As mensagens nunca incluem `detail` do PostgreSQL: ele pode conter valores de colunas
 * (telefone, e-mail) e não deve chegar a logs nem à interface.
 */

/** SQLSTATEs que a aplicação trata (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
export const PG_ERROR = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  notNullViolation: '23502',
  checkViolation: '23514',
  exclusionViolation: '23P01',
  insufficientPrivilege: '42501',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 8;

/** Subconjunto estável do `DatabaseError` do node-postgres usado aqui. */
export interface PostgresErrorInfo {
  readonly code: string;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
}

/** Procura o erro do PostgreSQL na cadeia `cause` (Drizzle embrulha o erro do driver). */
export function findPostgresError(error: unknown): PostgresErrorInfo | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Object; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; table?: unknown };
    if (typeof candidate.code === 'string' && SQLSTATE_PATTERN.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
        table: typeof candidate.table === 'string' ? candidate.table : undefined,
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Base dos erros traduzidos: `code` estável para a camada HTTP/UI decidir a resposta. */
export class DatabaseConstraintError extends Error {
  readonly code: string;
  readonly sqlState: string;
  readonly constraint: string | undefined;

  constructor(
    message: string,
    details: { code: string; sqlState: string; constraint: string | undefined; cause: unknown },
  ) {
    super(message, { cause: details.cause });
    this.name = new.target.name;
    this.code = details.code;
    this.sqlState = details.sqlState;
    this.constraint = details.constraint;
  }
}

/**
 * 23P01 (exclusion_violation): o horário do profissional já está ocupado, inclusive quando
 * duas reservas concorrentes disputam o mesmo intervalo (só uma faz commit).
 * HTTP sugerido: 409 com horários alternativos. Não retente cegamente.
 */
export class SlotUnavailableError extends DatabaseConstraintError {
  constructor(constraint: string | undefined, cause: unknown) {
    super('Horário indisponível: o profissional já está ocupado nesse intervalo.', {
      code: 'SLOT_UNAVAILABLE',
      sqlState: PG_ERROR.exclusionViolation,
      constraint,
      cause,
    });
  }
}

/**
 * 42501 (insufficient_privilege): a RLS recusou a linha (tenant diferente do contexto, ou
 * escrita sem contexto) ou o papel não tem o privilégio. Indica bug ou tentativa de acesso
 * cruzado: registre como evento de segurança e responda 404 (não confirme existência).
 */
export class TenantIsolationError extends DatabaseConstraintError {
  constructor(constraint: string | undefined, cause: unknown) {
    super('Operação recusada pelo isolamento de tenant ou por falta de privilégio no banco.', {
      code: 'TENANT_ISOLATION',
      sqlState: PG_ERROR.insufficientPrivilege,
      constraint,
      cause,
    });
  }
}

/**
 * 40P01 (deadlock_detected) ou 40001 (serialization_failure): o PostgreSQL abortou a
 * transação para resolver um conflito com outra simultânea. É transitório: `withTenant` já
 * repete a transação inteira algumas vezes antes de devolver este erro.
 * HTTP sugerido: 503 com `Retry-After` curto, sem detalhe.
 */
export class TransactionConflictError extends DatabaseConstraintError {
  constructor(sqlState: string, cause: unknown) {
    super('Conflito com outra operação simultânea; tente novamente.', {
      code: 'TRANSACTION_CONFLICT',
      sqlState,
      constraint: undefined,
      cause,
    });
  }
}

/** 23514 vindo do trigger da máquina de estados (transição ou status inicial inválido). */
export class InvalidStatusTransitionError extends DatabaseConstraintError {
  constructor(constraint: string | undefined, cause: unknown) {
    super('Transição de status do agendamento não permitida.', {
      code: 'INVALID_STATUS_TRANSITION',
      sqlState: PG_ERROR.checkViolation,
      constraint,
      cause,
    });
  }
}

/** 23505 na chave de idempotência: o mesmo comando de criação já foi processado. */
export class IdempotencyKeyConflictError extends DatabaseConstraintError {
  constructor(constraint: string | undefined, cause: unknown) {
    super('Chave de idempotência já utilizada para outro agendamento deste salão.', {
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      sqlState: PG_ERROR.uniqueViolation,
      constraint,
      cause,
    });
  }
}

/**
 * 23505 na PK `id` (`<tabela>_pkey`). A PK é GLOBAL (não começa por `tenant_id`): um id que
 * já existe em OUTRO tenant também colide, mesmo invisível pela RLS. Nunca responda "já
 * existe" (seria um oráculo de existência entre tenants): trate como erro genérico (HTTP 404
 * ou 409 sem detalhe). Ids são gerados no servidor (`newId()`); não aceite id vindo do cliente
 * em INSERT/upsert nem UPDATE de `id`.
 */
export class IdentifierConflictError extends DatabaseConstraintError {
  constructor(constraint: string | undefined, cause: unknown) {
    super('Operação recusada: identificador inválido.', {
      code: 'IDENTIFIER_CONFLICT',
      sqlState: PG_ERROR.uniqueViolation,
      constraint,
      cause,
    });
  }
}

/**
 * Uma consulta usou o `tx` de `withTenant` depois que a transação terminou (builder devolvido
 * dentro de um objeto, ramo de `Promise.all` que continuou depois da rejeição, `after()` ou
 * fire-and-forget com o `tx`). A consulta NÃO chega ao banco: sem esta guarda ela rodaria na
 * conexão já devolvida ao pool, dentro da transação de outra requisição (outro tenant).
 * Indica bug de programação: corrija o chamador (aguarde todos os ramos dentro do callback).
 */
export class TransactionClosedError extends Error {
  readonly code = 'TRANSACTION_CLOSED';

  constructor() {
    super('withTenant: transação encerrada; o tx só pode ser usado enquanto o callback executa.');
    this.name = new.target.name;
  }
}

const STATUS_TRANSITION_CONSTRAINTS: ReadonlySet<string> = new Set([
  'appointments_status_transition',
  'appointments_initial_status',
]);
const IDEMPOTENCY_CONSTRAINT = 'appointments_tenant_idempotency_key_key';
const PRIMARY_KEY_SUFFIX = '_pkey';

/**
 * Converte o erro do banco no erro de domínio correspondente; qualquer outro erro volta
 * inalterado (inclusive os que não vieram do PostgreSQL).
 */
export function mapDatabaseError(error: unknown): unknown {
  if (error instanceof DatabaseConstraintError) {
    return error;
  }
  const pgError = findPostgresError(error);
  if (pgError === undefined) {
    return error;
  }
  switch (pgError.code) {
    case PG_ERROR.exclusionViolation:
      return new SlotUnavailableError(pgError.constraint, error);
    case PG_ERROR.insufficientPrivilege:
      return new TenantIsolationError(pgError.constraint, error);
    case PG_ERROR.deadlockDetected:
    case PG_ERROR.serializationFailure:
      return new TransactionConflictError(pgError.code, error);
    case PG_ERROR.checkViolation:
      return pgError.constraint !== undefined &&
        STATUS_TRANSITION_CONSTRAINTS.has(pgError.constraint)
        ? new InvalidStatusTransitionError(pgError.constraint, error)
        : error;
    case PG_ERROR.uniqueViolation:
      if (pgError.constraint === IDEMPOTENCY_CONSTRAINT) {
        return new IdempotencyKeyConflictError(pgError.constraint, error);
      }
      return pgError.constraint?.endsWith(PRIMARY_KEY_SUFFIX) === true
        ? new IdentifierConflictError(pgError.constraint, error)
        : error;
    default:
      return error;
  }
}
