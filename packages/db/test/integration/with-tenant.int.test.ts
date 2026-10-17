import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Database } from '../../src/client';
import * as schema from '../../src/schema';
import { appointmentEvents, appointments, customers } from '../../src/schema';
import { withTenant } from '../../src/tenant';
import { captureSqlState, connectAsAppUser } from '../helpers/connections';
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
