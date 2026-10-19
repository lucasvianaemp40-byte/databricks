import { EventEmitter } from 'node:events';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { createDb } from './client';
import { SlotUnavailableError, TransactionConflictError } from './errors';
import { parseTenantId, type TenantTransaction, withTenant } from './tenant';

describe('parseTenantId', () => {
  it('normaliza para minúsculas', () => {
    expect(parseTenantId('550E8400-E29B-41D4-A716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it.each([
    '',
    "x'; select set_config('app.tenant_id', 'outro', false); --",
    '00000000-0000-0000-0000-000000000000',
    null,
  ])('recusa %j', (value) => {
    expect(() => parseTenantId(value)).toThrow(TypeError);
  });
});

describe('withTenant (validação antes de tocar no banco)', () => {
  // Pool apontando para lugar nenhum: se a validação falhar em barrar, a conexão seria tentada.
  const db = createDb('postgresql://127.0.0.1:1/inexistente', {
    connectionTimeoutMillis: 50,
    onPoolError: () => undefined,
  });

  it('recusa tenantId inválido sem abrir conexão', async () => {
    const connect = vi.spyOn(db.$client, 'connect');
    await expect(withTenant(db, 'tenant-a', () => Promise.resolve('nunca'))).rejects.toThrow(
      'tenantId precisa ser um UUID válido',
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'admin' as 'staff' }, 'actor.type inválido'],
    [{ type: 'staff' as const, id: '' }, 'actor.id'],
    [{ type: 'staff' as const, id: 'tem espaço' }, 'actor.id'],
    [{ type: 'staff' as const, id: 'x'.repeat(129) }, 'actor.id'],
  ])('recusa ator inválido %j', async (actor, message) => {
    await expect(
      withTenant(db, '550e8400-e29b-41d4-a716-446655440000', () => Promise.resolve(1), { actor }),
    ).rejects.toThrow(message);
  });

  it('recusa uma transação no lugar do banco (não troca de tenant no meio da transação)', async () => {
    const { $client: _client, ...notADatabase } = db;
    await expect(
      withTenant(notADatabase as unknown as typeof db, '550e8400-e29b-41d4-a716-446655440000', () =>
        Promise.resolve(1),
      ),
    ).rejects.toThrow('não uma transação');
  });
});

/** Percorre a cadeia `cause` (o Drizzle embrulha o erro do cliente em DrizzleQueryError). */
function errorNames(error: unknown): string[] {
  const names: string[] = [];
  for (let current = error; current instanceof Error && names.length < 8; current = current.cause) {
    names.push(current.name);
  }
  return names;
}

/**
 * PoolClient falso: registra o SQL que chega à conexão e deixa cada teste decidir o desfecho
 * de cada comando (resolver, segurar ou falhar). Fixa, sem banco e sem depender de tempo, a
 * guarda da conexão de withTenant: o que passa em cada fase e quando a conexão é destruída.
 */
function fakeConnection(
  outcome: (text: string) => Promise<undefined> = () => Promise.resolve(undefined),
) {
  const received: string[] = [];
  const release = vi.fn<(error?: Error | boolean) => void>();
  const query = vi.fn(async (config: string | { readonly text: string }) => {
    const text = (typeof config === 'string' ? config : config.text).trim().toLowerCase();
    received.push(text);
    await outcome(text);
    return { rows: [], fields: [], rowCount: 0, command: '' };
  });
  // EventEmitter como o pg.Client: emitir 'error' sem ouvinte lança (no processo real, uma
  // exceção não capturada que derruba o Node).
  const emitter = Object.assign(new EventEmitter(), { query, release });
  return { client: emitter as unknown as pg.PoolClient, emitter, received, release };
}

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const connectionLost = () => Promise.reject(new Error('conexão caiu'));

describe('withTenant: guarda da conexão (cliente falso, sem banco)', () => {
  const db = createDb('postgresql://127.0.0.1:1/inexistente', { onPoolError: () => undefined });

  function useConnection(fake: ReturnType<typeof fakeConnection>): void {
    // O tipo do spy pega a sobrecarga com callback de Pool.connect; withTenant usa a de Promise.
    const connect = vi.spyOn(db.$client, 'connect') as unknown as MockInstance<
      () => Promise<pg.PoolClient>
    >;
    connect.mockResolvedValue(fake.client);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('entre o fim do callback e o COMMIT, só o COMMIT passa: consulta atrasada nem chega à conexão', async () => {
    const commitGate = Promise.withResolvers<undefined>();
    const fake = fakeConnection((text) =>
      text === 'commit' ? commitGate.promise : Promise.resolve(undefined),
    );
    useConnection(fake);
    const captured: { tx?: TenantTransaction } = {};
    const pending = withTenant(db, TENANT_ID, (tx) => {
      captured.tx = tx;
      return Promise.resolve(1);
    });
    // O callback já resolveu e o COMMIT está em voo: é a janela da fase "finishing".
    await vi.waitFor(() => {
      expect(fake.received).toContain('commit');
    });
    const late = await captured.tx?.execute(sql`select 'tarde'`).then(
      () => 'executou',
      (error: unknown) => error,
    );
    expect(errorNames(late)).toContain('TransactionClosedError');
    expect(fake.received.filter((text) => text.includes('tarde'))).toEqual([]);

    commitGate.resolve(undefined);
    await expect(pending).resolves.toBe(1);
    // COMMIT confirmado e nada pendente: a conexão volta ao pool.
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it.each([
    {
      label: 'BEGIN falha',
      fails: (text: string) => text.startsWith('begin'),
      callbackFails: false,
      destroyed: true,
    },
    {
      label: 'COMMIT e ROLLBACK falham',
      fails: (text: string) => text === 'commit' || text === 'rollback',
      callbackFails: false,
      destroyed: true,
    },
    {
      label: 'callback falha e o ROLLBACK também',
      fails: (text: string) => text === 'rollback',
      callbackFails: true,
      destroyed: true,
    },
    {
      label: 'callback falha e o ROLLBACK confirma',
      fails: () => false,
      callbackFails: true,
      destroyed: false,
    },
  ])('$label: conexão destruída = $destroyed', async ({ fails, callbackFails, destroyed }) => {
    const fake = fakeConnection((text) =>
      fails(text) ? connectionLost() : Promise.resolve(undefined),
    );
    useConnection(fake);
    await expect(
      withTenant(db, TENANT_ID, () =>
        callbackFails ? Promise.reject(new Error('regra de negócio')) : Promise.resolve(1),
      ),
    ).rejects.toThrow();
    expect(fake.release).toHaveBeenCalledOnce();
    const [releaseArgument] = fake.release.mock.calls[0] ?? [];
    // pg-pool: release(erro) destrói a conexão; release() a devolve ao pool.
    if (destroyed) {
      expect(releaseArgument).toBeInstanceOf(Error);
    } else {
      expect(releaseArgument).toBeUndefined();
    }
  });

  it('queda da conexão emprestada entre consultas: o erro não derruba o processo e a conexão é destruída', async () => {
    // O pool tira o próprio ouvinte de 'error' enquanto a conexão está emprestada e o devolve
    // no release: sem um ouvinte de withTenant, um failover ou pg_terminate_backend durante o
    // callback viraria exceção não capturada.
    const fake = fakeConnection();
    useConnection(fake);
    const listenersDuringCallback: number[] = [];
    await expect(
      withTenant(db, TENANT_ID, () => {
        listenersDuringCallback.push(fake.emitter.listenerCount('error'));
        fake.emitter.emit(
          'error',
          new Error('terminating connection due to administrator command'),
        );
        return Promise.resolve(1);
      }),
    ).resolves.toBe(1);
    expect(listenersDuringCallback).toEqual([1]);
    // Conexão que emitiu erro nunca volta ao pool, e o ouvinte sai antes do release.
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(fake.emitter.listenerCount('error')).toBe(0);
  });

  it('o ouvinte de erro sai também quando a conexão volta limpa ao pool', async () => {
    const fake = fakeConnection();
    useConnection(fake);
    await expect(withTenant(db, TENANT_ID, () => Promise.resolve(1))).resolves.toBe(1);
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(fake.emitter.listenerCount('error')).toBe(0);
  });

  it('consulta ainda em voo quando a transação termina (fire-and-forget): a conexão é destruída', async () => {
    const slowGate = Promise.withResolvers<undefined>();
    const fake = fakeConnection((text) =>
      text.includes('lenta') ? slowGate.promise : Promise.resolve(undefined),
    );
    useConnection(fake);
    let orphan: Promise<unknown> = Promise.resolve();
    await expect(
      withTenant(db, TENANT_ID, (tx) => {
        orphan = tx.execute(sql`select 'lenta'`).catch((error: unknown) => error);
        return Promise.resolve(1);
      }),
    ).resolves.toBe(1);
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    slowGate.resolve(undefined);
    await orphan;
  });
});

/** Erro como o node-postgres entrega (só o SQLSTATE importa aqui). */
function postgresError(code: string): Error {
  return Object.assign(new Error(`erro ${code}`), { code });
}

describe('withTenant: conflito transitório (deadlock, serialização) repete a transação', () => {
  const db = createDb('postgresql://127.0.0.1:1/inexistente', { onPoolError: () => undefined });

  /** Toda tentativa recebe o mesmo cliente falso; o spy conta as conexões pedidas ao pool. */
  function stubConnect(fake: ReturnType<typeof fakeConnection>) {
    // O tipo do spy pega a sobrecarga com callback de Pool.connect; withTenant usa a de Promise.
    const connect = vi.spyOn(db.$client, 'connect') as unknown as MockInstance<
      () => Promise<pg.PoolClient>
    >;
    connect.mockResolvedValue(fake.client);
    return connect;
  }

  /** A consulta 'reserva' falha com `code` nas primeiras `failures` vezes; o resto passa. */
  function connectionFailingWith(code: string, failures: number) {
    let remaining = failures;
    const fake = fakeConnection((text) => {
      if (text.includes('reserva') && remaining > 0) {
        remaining -= 1;
        return Promise.reject(postgresError(code));
      }
      return Promise.resolve(undefined);
    });
    const connect = stubConnect(fake);
    const callback = vi.fn(async (tx: TenantTransaction) => {
      await tx.execute(sql`select 'reserva'`);
      return 'reservado';
    });
    return { fake, connect, callback };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deadlock (40P01): repete o callback numa transação nova e devolve o resultado', async () => {
    const { fake, connect, callback } = connectionFailingWith('40P01', 1);
    await expect(withTenant(db, TENANT_ID, callback)).resolves.toBe('reservado');
    expect(callback).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    // A tentativa que falhou terminou em ROLLBACK e a conexão voltou limpa ao pool.
    expect(fake.received.filter((text) => text === 'rollback')).toHaveLength(1);
    expect(fake.received.filter((text) => text === 'commit')).toHaveLength(1);
    expect(fake.release.mock.calls).toEqual([[undefined], [undefined]]);
  });

  it('falha de serialização persistente (40001): desiste depois de 3 tentativas', async () => {
    const { callback } = connectionFailingWith('40001', Number.POSITIVE_INFINITY);
    const outcome = withTenant(db, TENANT_ID, callback);
    await expect(outcome).rejects.toBeInstanceOf(TransactionConflictError);
    await expect(outcome).rejects.toMatchObject({
      code: 'TRANSACTION_CONFLICT',
      sqlState: '40001',
    });
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['horário tomado (23P01)', postgresError('23P01'), SlotUnavailableError],
    ['erro de regra no callback', new Error('regra de negócio'), Error],
  ])('não repete o que não é transitório: %s', async (_label, failure, ErrorClass) => {
    const connect = stubConnect(fakeConnection());
    const callback = vi.fn(() => Promise.reject(failure));
    await expect(withTenant(db, TENANT_ID, callback)).rejects.toBeInstanceOf(ErrorClass);
    expect(callback).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });
});

describe('createDb', () => {
  it('recusa URL que não é PostgreSQL', () => {
    expect(() => createDb('mysql://localhost/db')).toThrow(TypeError);
  });
});
