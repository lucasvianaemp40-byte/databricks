import { randomBytes } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Database } from '../../src/client';
import * as schema from '../../src/schema';
import { appointmentEvents, appointments, customers, occupancies } from '../../src/schema';
import { withTenant } from '../../src/tenant';
import { captureSqlState, connectAsAdmin, connectAsAppUser } from '../helpers/connections';
import { bookAppointment, createTenantFixture, type TenantFixture } from '../helpers/fixtures';

describe('withTenant: contexto por transação', () => {
  let db: Database;
  /** Pool com UMA conexão: toda transação reaproveita a mesma sessão do PostgreSQL. */
  let singleConnection: Database;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    db = connectAsAppUser();
    singleConnection = connectAsAppUser(1);
    tenantA = await createTenantFixture(db);
    tenantB = await createTenantFixture(db);
  });

  afterAll(async () => {
    await Promise.all([db.$client.end(), singleConnection.$client.end()]);
  });

  it('regressão: o GUC não vaza entre transações na mesma conexão e não vira 22P02', async () => {
    const ownRows = await withTenant(singleConnection, tenantA.tenantId, (tx) =>
      tx.select({ id: customers.id }).from(customers),
    );
    expect(ownRows.length).toBeGreaterThan(0);

    // Mesma sessão, fora de transação: o GUC customizado volta como '' (não NULL). Sem o
    // NULLIF da política, `''::uuid` lançaria 22P02 aqui.
    const client = singleConnection.$client;
    const { rows: setting } = await client.query<{ value: string | null }>(
      "SELECT current_setting('app.tenant_id', true) AS value",
    );
    expect(setting[0]?.value).toBe('');
    const { rows: leaked } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.customers',
    );
    expect(leaked[0]?.n).toBe(0);

    // A transação seguinte na MESMA conexão enxerga só o novo tenant.
    const tenantsSeen = await withTenant(singleConnection, tenantB.tenantId, (tx) =>
      tx.selectDistinct({ tenantId: customers.tenantId }).from(customers),
    );
    expect(tenantsSeen).toEqual([{ tenantId: tenantB.tenantId }]);
  });

  it('o contexto também some depois de uma transação que falhou (rollback)', async () => {
    await expect(
      withTenant(singleConnection, tenantA.tenantId, async (tx) => {
        await tx.select().from(customers);
        throw new Error('falha de propósito');
      }),
    ).rejects.toThrow('falha de propósito');
    const { rows } = await singleConnection.$client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.customers',
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('transações concorrentes de tenants diferentes não se misturam', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => {
        const tenant = index % 2 === 0 ? tenantA : tenantB;
        return withTenant(db, tenant.tenantId, async (tx) => {
          const rows = await tx.selectDistinct({ tenantId: customers.tenantId }).from(customers);
          return { expected: tenant.tenantId, seen: rows.map((row) => row.tenantId) };
        });
      }),
    );
    for (const result of results) {
      expect(result.seen).toEqual([result.expected]);
    }
  });

  it('registra o ator na auditoria e marca "unknown" quando a transação não informa', async () => {
    const withActor = await withTenant(
      db,
      tenantA.tenantId,
      (tx) =>
        bookAppointment(tx, tenantA, {
          staffId: tenantA.staffIds[1],
          startsAt: new Date('2026-12-10T12:00:00Z'),
          endsAt: new Date('2026-12-10T13:00:00Z'),
        }),
      { actor: { type: 'customer', id: 'customer-portal:123' } },
    );
    const withoutActor = await withTenant(db, tenantA.tenantId, (tx) =>
      bookAppointment(tx, tenantA, {
        staffId: tenantA.staffIds[1],
        startsAt: new Date('2026-12-11T12:00:00Z'),
        endsAt: new Date('2026-12-11T13:00:00Z'),
      }),
    );

    const events = await withTenant(db, tenantA.tenantId, (tx) =>
      tx
        .select({
          appointmentId: appointmentEvents.appointmentId,
          actorType: appointmentEvents.actorType,
          actorId: appointmentEvents.actorId,
        })
        .from(appointmentEvents)
        .where(
          sql`${appointmentEvents.appointmentId} IN (${withActor.appointmentId}, ${withoutActor.appointmentId})`,
        )
        .orderBy(asc(appointmentEvents.createdAt)),
    );
    expect(events).toEqual([
      {
        appointmentId: withActor.appointmentId,
        actorType: 'customer',
        actorId: 'customer-portal:123',
      },
      { appointmentId: withoutActor.appointmentId, actorType: 'unknown', actorId: null },
    ]);
  });

  it('devolve instantes corretos mesmo com TimeZone/DateStyle hostis na sessão', async () => {
    // Sessão configurada como um servidor "brasileiro" mal configurado + fuso com meia hora.
    const hostilePool = new pg.Pool({
      connectionString: inject('appUserDatabaseUrl'),
      max: 1,
      options: '-c TimeZone=Asia/Kolkata -c DateStyle=SQL,DMY',
    });
    const hostile = drizzle({ client: hostilePool, schema });
    try {
      const startsAt = new Date('2026-12-15T13:07:09.123Z');
      const booked = await withTenant(hostile, tenantA.tenantId, (tx) =>
        bookAppointment(tx, tenantA, {
          staffId: tenantA.staffIds[1],
          startsAt,
          endsAt: new Date('2026-12-15T14:07:09.123Z'),
        }),
      );
      const [row] = await withTenant(hostile, tenantA.tenantId, (tx) =>
        tx
          .select({ startsAt: appointments.startsAt, local: appointments.localStartsAt })
          .from(appointments)
          .where(eq(appointments.id, booked.appointmentId)),
      );
      expect(row?.startsAt.toISOString()).toBe(startsAt.toISOString());
      expect(row?.local).toBe('2026-12-15 10:07:09');
    } finally {
      await hostilePool.end();
    }
  });

  it('readOnly abre a transação como READ ONLY', async () => {
    expect(
      await captureSqlState(
        withTenant(
          db,
          tenantA.tenantId,
          (tx) => tx.insert(customers).values({ fullName: 'Não deve gravar' }),
          { readOnly: true },
        ),
      ),
    ).toBe('25006');
  });

  it('recusa tenantId inválido antes de abrir conexão', async () => {
    const before = db.$client.totalCount;
    await expect(withTenant(db, "'; select 1; --", () => Promise.resolve(1))).rejects.toThrow(
      TypeError,
    );
    await expect(
      withTenant(db, '00000000-0000-0000-0000-000000000000', () => Promise.resolve(1)),
    ).rejects.toThrow(TypeError);
    expect(db.$client.totalCount).toBe(before);
  });
});

/** Percorre a cadeia `cause` (o Drizzle embrulha o erro do driver em DrizzleQueryError). */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current instanceof Error && chain.length < 8; current = current.cause) {
    chain.push(current);
  }
  return chain;
}

const isTransactionClosed = (error: unknown): boolean =>
  errorChain(error).some((link) => link instanceof Error && link.name === 'TransactionClosedError');

/**
 * O `tx` de withTenant vale só enquanto o callback roda. Sem a guarda, uma consulta que
 * escapa do callback (builder devolvido dentro de um objeto, ramo de Promise.all que continua
 * depois da rejeição, fire-and-forget) roda mais tarde no PoolClient já devolvido ao pool,
 * dentro da transação de OUTRA requisição, com o tenant DELA: a RLS não percebe.
 * O pool reaproveita primeiro a conexão liberada mais recentemente (LIFO), então a próxima
 * transação usa a mesma conexão.
 */
describe('withTenant: o tx não sobrevive ao callback', () => {
  let db: Database;
  let admin: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    db = connectAsAppUser();
    admin = connectAsAdmin();
    tenantA = await createTenantFixture(db);
    tenantB = await createTenantFixture(db);
  });

  afterAll(async () => {
    await Promise.all([db.$client.end(), admin.end()]);
  });

  it('builder devolvido num objeto e executado depois é recusado (não lê o tenant de outra transação)', async () => {
    const escaped = await withTenant(db, tenantA.tenantId, (tx) =>
      Promise.resolve({
        list: tx
          .select({ fullName: customers.fullName, tenantId: customers.tenantId })
          .from(customers),
      }),
    );
    const outcome = await withTenant(db, tenantB.tenantId, async (tx) => {
      const own = await tx.select({ id: customers.id }).from(customers);
      const leaked = await escaped.list.then(
        (rows) => rows,
        (error: unknown) => error,
      );
      return { own: own.length, leaked };
    });
    expect(outcome.own).toBeGreaterThan(0);
    expect(isTransactionClosed(outcome.leaked), JSON.stringify(outcome.leaked)).toBe(true);
  });

  it('Promise.all com ramo que falha: o ramo irmão não grava depois, nem na transação de outro tenant', async () => {
    const marker = `orfa-${randomBytes(4).toString('hex')}`;
    const insideB = Promise.withResolvers<undefined>();
    let sibling: Promise<unknown> = Promise.resolve();
    const requestA = withTenant(db, tenantA.tenantId, (tx) => {
      const late = (async () => {
        await insideB.promise;
        await tx.insert(customers).values({ fullName: marker });
        return 'gravou';
      })();
      sibling = late.catch((error: unknown) => error);
      return Promise.all([Promise.reject(new Error('validação falhou')), late]);
    });
    await expect(requestA).rejects.toThrow('validação falhou');

    await withTenant(db, tenantB.tenantId, async (tx) => {
      await tx.select({ id: customers.id }).from(customers).limit(1);
      insideB.resolve(undefined);
      await sibling;
    });

    expect(isTransactionClosed(await sibling)).toBe(true);
    const { rows } = await admin.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM app.customers WHERE full_name = $1',
      [marker],
    );
    expect(rows).toEqual([]);
  });

  it('depois do callback a conexão volta ociosa ao pool, e a consulta atrasada não a toca', async () => {
    const escaped = await withTenant(db, tenantA.tenantId, (tx) =>
      Promise.resolve({ run: () => tx.execute(sql`select 1`) }),
    );
    expect(db.$client.idleCount).toBe(db.$client.totalCount);
    const before = db.$client.totalCount;
    expect(
      isTransactionClosed(
        await escaped.run().then(
          () => 'executou',
          (error: unknown) => error,
        ),
      ),
    ).toBe(true);
    expect(db.$client.totalCount).toBe(before);
    expect(db.$client.idleCount).toBe(db.$client.totalCount);
  });

  it('conexão derrubada no meio do callback (failover): falha fechado, sem erro não capturado, e o pool a descarta', async () => {
    const acquired: pg.PoolClient[] = [];
    const removed: pg.PoolClient[] = [];
    const onAcquire = (client: pg.PoolClient) => {
      acquired.push(client);
    };
    const onRemove = (client: pg.PoolClient) => {
      removed.push(client);
    };
    db.$client.on('acquire', onAcquire);
    db.$client.on('remove', onRemove);
    let outcome: unknown;
    try {
      outcome = await withTenant(db, tenantA.tenantId, async (tx) => {
        const [connection] = acquired;
        const { rows } = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        const ended = new Promise((resolve) => {
          connection?.once('end', resolve);
        });
        await admin.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);
        // O cliente recebeu o FATAL sem consulta ativa (emite 'error') e o fim do socket.
        await ended;
        return 'fim do callback';
      }).then(
        () => 'concluiu',
        (error: unknown) => error,
      );
    } finally {
      db.$client.off('acquire', onAcquire);
      db.$client.off('remove', onRemove);
    }
    // O COMMIT não tem como acontecer: withTenant rejeita, e a conexão sai do pool.
    expect(outcome).toBeInstanceOf(Error);
    expect(acquired).toHaveLength(1);
    expect(removed).toEqual(acquired);
    await expect(
      withTenant(db, tenantA.tenantId, (tx) => tx.execute(sql`select 1`)),
    ).resolves.toBeDefined();
  });
});

/**
 * withTenant fixa READ COMMITTED: o FOR SHARE do trigger occupancies_derive_active só
 * serializa ocupação nova x mudança de status nesse nível. Em REPEATABLE READ (padrão do
 * banco/papel/URL alterado), o UPDATE de sincronização usaria o snapshot antigo e deixaria
 * ativa a ocupação criada em paralelo a um cancelamento.
 */
describe('withTenant: nível de isolamento fixo', () => {
  let db: Database;
  let repeatableReadPool: pg.Pool;
  let repeatableRead: Database;
  let tenant: TenantFixture;

  beforeAll(async () => {
    db = connectAsAppUser();
    repeatableReadPool = new pg.Pool({
      connectionString: inject('appUserDatabaseUrl'),
      max: 1,
      options: '-c default_transaction_isolation=repeatable\\ read',
    });
    repeatableRead = drizzle({ client: repeatableReadPool, schema });
    tenant = await createTenantFixture(db);
  });

  afterAll(async () => {
    await Promise.all([db.$client.end(), repeatableReadPool.end()]);
  });

  it('abre a transação em READ COMMITTED mesmo com outro padrão na sessão', async () => {
    const { rows } = await repeatableReadPool.query<{ transaction_isolation: string }>(
      'SHOW transaction_isolation',
    );
    expect(rows[0]?.transaction_isolation).toBe('repeatable read');
    for (const readOnly of [false, true]) {
      const level = await withTenant(
        repeatableRead,
        tenant.tenantId,
        async (tx) =>
          (await tx.execute<{ transaction_isolation: string }>(sql`SHOW transaction_isolation`))
            .rows[0]?.transaction_isolation,
        { readOnly },
      );
      expect(level, `readOnly=${String(readOnly)}`).toBe('read committed');
    }
  });

  it('ocupação nova concorrente a um cancelamento termina inativa', async () => {
    const [ana] = tenant.staffIds;
    const at = (iso: string) => new Date(iso);
    const booked = await withTenant(db, tenant.tenantId, (tx) =>
      bookAppointment(tx, tenant, {
        staffId: ana,
        startsAt: at('2027-04-05T13:00:00Z'),
        endsAt: at('2027-04-05T14:00:00Z'),
        // Fase de trabalho e pausa: a 2ª ocupação (na pausa) entra depois, em paralelo ao cancelamento.
        item: {
          phases: [
            { kind: 'work', minutes: 30 },
            { kind: 'pause', minutes: 30 },
          ],
        },
        occupancies: [{ startsAt: at('2027-04-05T13:00:00Z'), endsAt: at('2027-04-05T13:30:00Z') }],
      }),
    );
    const secondPhaseCommitted = Promise.withResolvers<undefined>();
    const cancellation = withTenant(repeatableRead, tenant.tenantId, async (tx) => {
      // Primeira consulta: em REPEATABLE READ, o snapshot da transação inteira nasce aqui.
      await tx.select({ id: appointments.id }).from(appointments).limit(1);
      await secondPhaseCommitted.promise;
      await tx
        .update(appointments)
        .set({ status: 'cancelled_by_salon' })
        .where(eq(appointments.id, booked.appointmentId));
    });
    await withTenant(db, tenant.tenantId, (tx) =>
      tx.insert(occupancies).values({
        appointmentId: booked.appointmentId,
        appointmentItemId: booked.itemId,
        staffId: ana,
        startsAt: at('2027-04-05T13:30:00Z'),
        endsAt: at('2027-04-05T14:00:00Z'),
      }),
    );
    secondPhaseCommitted.resolve(undefined);
    await cancellation;

    const rows = await withTenant(db, tenant.tenantId, (tx) =>
      tx
        .select({ active: occupancies.active })
        .from(occupancies)
        .where(eq(occupancies.appointmentId, booked.appointmentId)),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.active)).toBe(true);
  });
});
