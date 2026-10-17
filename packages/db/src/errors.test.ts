import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import {
  DatabaseConstraintError,
  findPostgresError,
  IdempotencyKeyConflictError,
  InvalidStatusTransitionError,
  mapDatabaseError,
  SlotUnavailableError,
  TenantIsolationError,
} from './errors';

/** Imita o DatabaseError do node-postgres (só os campos lidos pelo mapeamento). */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`erro ${code}`), {
    code,
    constraint,
    // biome-ignore lint/security/noSecrets: telefone fictício; simula o DETAIL do PostgreSQL.
    detail: 'Key (phone_e164)=(+5511999990001) already exists.',
  });
}

/** Como o Drizzle 0.45 entrega o erro: embrulhado, com o original em `cause`. */
function wrapped(error: Error): DrizzleQueryError {
  return new DrizzleQueryError('insert into "app"."occupancies" ...', [], error);
}

describe('findPostgresError', () => {
  it('encontra o erro do driver dentro do DrizzleQueryError', () => {
    expect(findPostgresError(wrapped(pgError('23P01', 'occupancies_no_staff_overlap')))).toEqual({
      code: '23P01',
      constraint: 'occupancies_no_staff_overlap',
      table: undefined,
    });
  });

  it('ignora valores que não são SQLSTATE e erros comuns', () => {
    expect(findPostgresError(new Error('x'))).toBeUndefined();
    expect(
      findPostgresError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
    ).toBeUndefined();
    expect(findPostgresError('23P01')).toBeUndefined();
    expect(findPostgresError(null)).toBeUndefined();
  });

  it('não entra em laço com cadeia de cause circular', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(findPostgresError(a)).toBeUndefined();
  });
});

describe('mapDatabaseError', () => {
  it.each([
    ['23P01', 'occupancies_no_staff_overlap', SlotUnavailableError, 'SLOT_UNAVAILABLE'],
    ['42501', undefined, TenantIsolationError, 'TENANT_ISOLATION'],
    [
      '23514',
      'appointments_status_transition',
      InvalidStatusTransitionError,
      'INVALID_STATUS_TRANSITION',
    ],
    [
      '23514',
      'appointments_initial_status',
      InvalidStatusTransitionError,
      'INVALID_STATUS_TRANSITION',
    ],
    [
      '23505',
      'appointments_tenant_idempotency_key_key',
      IdempotencyKeyConflictError,
      'IDEMPOTENCY_KEY_CONFLICT',
    ],
  ] as const)('%s (%s) vira %s', (code, constraint, ErrorClass, stableCode) => {
    const original = wrapped(pgError(code, constraint));
    const mapped = mapDatabaseError(original);
    expect(mapped).toBeInstanceOf(ErrorClass);
    expect(mapped).toBeInstanceOf(DatabaseConstraintError);
    expect(mapped).toMatchObject({ code: stableCode, sqlState: code, constraint });
    expect((mapped as Error).cause).toBe(original);
    expect((mapped as Error).name).toBe(ErrorClass.name);
  });

  it('não vaza o DETAIL do PostgreSQL (pode conter dados pessoais) na mensagem', () => {
    const mapped = mapDatabaseError(wrapped(pgError('23P01'))) as Error;
    expect(mapped.message).not.toContain('+5511');
  });

  it.each([
    ['23514 de outra constraint', pgError('23514', 'customers_phone_e164')],
    ['23505 de outra unique', pgError('23505', 'customers_tenant_phone_key')],
    ['23503 (FK)', pgError('23503', 'appointments_customer_fk')],
    ['erro que não é do banco', new Error('rede caiu')],
  ])('devolve inalterado: %s', (_label, error) => {
    expect(mapDatabaseError(error)).toBe(error);
  });

  it('é idempotente para erros já traduzidos', () => {
    const mapped = mapDatabaseError(pgError('23P01'));
    expect(mapDatabaseError(mapped)).toBe(mapped);
  });
});
