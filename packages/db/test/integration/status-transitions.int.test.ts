import {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  allowedTransitions,
  canTransition,
  INITIAL_APPOINTMENT_STATUSES,
  occupiesSchedule,
} from '@salon/scheduling-core';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/client';
import {
  findPostgresError,
  InvalidStatusTransitionError,
  TenantIsolationError,
} from '../../src/errors';
import { appointmentEvents, appointments, occupancies } from '../../src/schema';
import { type TenantTransaction, withTenant } from '../../src/tenant';
import { connectAsAppUser, connectAsWorker } from '../helpers/connections';
import {
  bookAppointment,
  createTenantFixture,
  first,
  randomIdempotencyKey,
  type TenantFixture,
  utcOffsetSeconds,
  wallTime,
} from '../helpers/fixtures';

/** Caminho mais curto (BFS em allowedTransitions do core) de um status inicial até `target`. */
function pathTo(target: AppointmentStatus): {
  initial: 'pending' | 'confirmed';
  steps: AppointmentStatus[];
} {
  const queue: {
    status: AppointmentStatus;
    initial: 'pending' | 'confirmed';
    steps: AppointmentStatus[];
  }[] = INITIAL_APPOINTMENT_STATUSES.map((status) => ({ status, initial: status, steps: [] }));
  const seen = new Set<AppointmentStatus>(INITIAL_APPOINTMENT_STATUSES);
  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    if (node.status === target) {
      return { initial: node.initial, steps: node.steps };
    }
    for (const next of allowedTransitions(node.status)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push({ status: next, initial: node.initial, steps: [...node.steps, next] });
      }
    }
  }
  throw new Error(`status inalcançável: ${target}`);
}

describe('máquina de estados do agendamento (trigger appointments_guard_status)', () => {
  let db: Database;
  let tenant: TenantFixture;
  let slot = 0;

  beforeAll(async () => {
    db = connectAsAppUser();
    tenant = await createTenantFixture(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  /** Cada agendamento num horário próprio: reativações nunca colidem entre si. */
  function nextSlot(): { startsAt: Date; endsAt: Date } {
    slot += 1;
    const startsAt = new Date(Date.UTC(2027, 5, 1, 0, 0) + slot * 2 * 60 * 60 * 1000);
    return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000) };
  }

  async function createIn(tx: TenantTransaction, target: AppointmentStatus) {
    const { initial, steps } = pathTo(target);
    const booked = await bookAppointment(tx, tenant, {
      staffId: tenant.staffIds[1],
      status: initial,
      ...nextSlot(),
    });
    for (const status of steps) {
      await tx
        .update(appointments)
        .set({ status })
        .where(eq(appointments.id, booked.appointmentId));
    }
    return booked;
  }

  it('todo status é alcançável a partir dos estados iniciais', () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(() => pathTo(status)).not.toThrow();
    }
  });

  it('o trigger aceita EXATAMENTE as transições do core (todos os 81 pares)', async () => {
    const mismatches: string[] = [];
    await withTenant(
      db,
      tenant.tenantId,
      async (tx) => {
        for (const from of APPOINTMENT_STATUSES) {
          const booked = await createIn(tx, from);
          for (const to of APPOINTMENT_STATUSES) {
            if (to === from) {
              continue;
            }
            const expected = canTransition(from, to);
            await tx.execute(sql`SAVEPOINT transition_probe`);
            let accepted = false;
            try {
              await tx
                .update(appointments)
                .set({ status: to })
                .where(eq(appointments.id, booked.appointmentId));
              accepted = true;
              const occupancy = first(
                await tx
                  .select({ active: occupancies.active })
                  .from(occupancies)
                  .where(eq(occupancies.id, booked.occupancyId)),
              );
              if (occupancy.active !== occupiesSchedule(to)) {
                mismatches.push(`${from} -> ${to}: ocupação active=${occupancy.active}`);
              }
            } catch (error) {
              const pgError = findPostgresError(error);
              if (
                pgError?.code !== '23514' ||
                pgError.constraint !== 'appointments_status_transition'
              ) {
                mismatches.push(
                  `${from} -> ${to}: erro inesperado ${pgError?.code ?? String(error)}`,
                );
              }
            }
            await tx.execute(sql`ROLLBACK TO SAVEPOINT transition_probe`);
            if (accepted !== expected) {
              mismatches.push(
                `${from} -> ${to}: banco ${accepted ? 'aceitou' : 'recusou'}, TS ${expected ? 'permite' : 'proíbe'}`,
              );
            }
          }
        }
      },
      { actor: { type: 'staff', id: 'matrix' } },
    );
    expect(mismatches).toEqual([]);
  });

  it('só nasce como pending ou confirmed', async () => {
    for (const status of APPOINTMENT_STATUSES) {
      if ((INITIAL_APPOINTMENT_STATUSES as readonly string[]).includes(status)) {
        continue;
      }
      const { startsAt, endsAt } = nextSlot();
      const attempt = withTenant(db, tenant.tenantId, (tx) =>
        tx.insert(appointments).values({
          locationId: tenant.locationId,
          customerId: tenant.customerId,
          status,
          source: 'staff',
          startsAt,
          endsAt,
          localStartsAt: wallTime(startsAt),
          localUtcOffsetSeconds: utcOffsetSeconds(startsAt),
          timezone: 'America/Sao_Paulo',
          idempotencyKey: randomIdempotencyKey(),
        }),
      );
      await expect(attempt, status).rejects.toBeInstanceOf(InvalidStatusTransitionError);
      await expect(attempt, status).rejects.toMatchObject({
        constraint: 'appointments_initial_status',
      });
    }
  });

  it('transição inválida via withTenant vira InvalidStatusTransitionError', async () => {
    const booked = await withTenant(db, tenant.tenantId, (tx) => createIn(tx, 'completed'));
    await expect(
      withTenant(db, tenant.tenantId, (tx) =>
        tx
          .update(appointments)
          .set({ status: 'cancelled_by_customer' })
          .where(eq(appointments.id, booked.appointmentId)),
      ),
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });

  it('preenche instantes, zera o hold ao confirmar, incrementa version e audita cada transição', async () => {
    const { startsAt, endsAt } = nextSlot();
    const booked = await withTenant(
      db,
      tenant.tenantId,
      (tx) =>
        bookAppointment(tx, tenant, {
          staffId: tenant.staffIds[1],
          status: 'pending',
          holdExpiresAt: new Date('2099-01-01T00:00:00Z'),
          startsAt,
          endsAt,
        }),
      { actor: { type: 'customer', id: 'booking-page' } },
    );
    for (const status of ['confirmed', 'checked_in', 'in_service', 'completed'] as const) {
      await withTenant(
        db,
        tenant.tenantId,
        (tx) =>
          tx.update(appointments).set({ status }).where(eq(appointments.id, booked.appointmentId)),
        { actor: { type: 'staff', id: 'recepcao' } },
      );
    }

    const row = first(
      await withTenant(db, tenant.tenantId, (tx) =>
        tx.select().from(appointments).where(eq(appointments.id, booked.appointmentId)),
      ),
    );
    expect(row.status).toBe('completed');
    expect(row.holdExpiresAt).toBeNull();
    expect(row.confirmedAt).toBeInstanceOf(Date);
    expect(row.checkedInAt).toBeInstanceOf(Date);
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.cancelledAt).toBeNull();
    expect(row.version).toBe(5);
    expect(row.localStartsAt).toBe(wallTime(startsAt));

    const events = await withTenant(db, tenant.tenantId, (tx) =>
      tx
        .select({
          eventType: appointmentEvents.eventType,
          fromStatus: appointmentEvents.fromStatus,
          toStatus: appointmentEvents.toStatus,
          actorType: appointmentEvents.actorType,
          actorId: appointmentEvents.actorId,
        })
        .from(appointmentEvents)
        .where(eq(appointmentEvents.appointmentId, booked.appointmentId))
        .orderBy(asc(appointmentEvents.createdAt)),
    );
    expect(events).toEqual([
      {
        eventType: 'created',
        fromStatus: null,
        toStatus: 'pending',
        actorType: 'customer',
        actorId: 'booking-page',
      },
      {
        eventType: 'status_changed',
        fromStatus: 'pending',
        toStatus: 'confirmed',
        actorType: 'staff',
        actorId: 'recepcao',
      },
      {
        eventType: 'status_changed',
        fromStatus: 'confirmed',
        toStatus: 'checked_in',
        actorType: 'staff',
        actorId: 'recepcao',
      },
      {
        eventType: 'status_changed',
        fromStatus: 'checked_in',
        toStatus: 'in_service',
        actorType: 'staff',
        actorId: 'recepcao',
      },
      {
        eventType: 'status_changed',
        fromStatus: 'in_service',
        toStatus: 'completed',
        actorType: 'staff',
        actorId: 'recepcao',
      },
    ]);
  });

  describe('instantes de transição e hold: o valor enviado pela aplicação é ignorado', () => {
    const forged = new Date('1999-01-01T00:00:00.000Z');
    const instantsOf = (row: typeof appointments.$inferSelect) => ({
      holdExpiresAt: row.holdExpiresAt,
      confirmedAt: row.confirmedAt,
      checkedInAt: row.checkedInAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      noShowAt: row.noShowAt,
      expiredAt: row.expiredAt,
      createdAt: row.createdAt,
    });

    async function readRow(appointmentId: string) {
      return first(
        await withTenant(db, tenant.tenantId, (tx) =>
          tx.select().from(appointments).where(eq(appointments.id, appointmentId)),
        ),
      );
    }

    /** `now()` da transação, lido como o driver lê um timestamptz (milissegundos). */
    async function transactionNow(tx: TenantTransaction): Promise<number> {
      const { rows } = await tx.execute<{ now: string }>(sql`select now()::text as now`);
      return new Date(first(rows).now).getTime();
    }

    it('UPDATE sem mudar o status não altera instantes, created_at nem o hold', async () => {
      const booked = await withTenant(db, tenant.tenantId, (tx) => createIn(tx, 'confirmed'));
      const before = await readRow(booked.appointmentId);
      await withTenant(db, tenant.tenantId, (tx) =>
        tx
          .update(appointments)
          .set({
            holdExpiresAt: new Date('2099-01-01T00:00:00Z'),
            confirmedAt: null,
            checkedInAt: forged,
            startedAt: forged,
            completedAt: forged,
            cancelledAt: forged,
            noShowAt: forged,
            expiredAt: forged,
            createdAt: forged,
          })
          .where(eq(appointments.id, booked.appointmentId)),
      );
      expect(instantsOf(await readRow(booked.appointmentId))).toEqual(instantsOf(before));
    });

    it('transição grava o now() da transação, não o instante enviado', async () => {
      const booked = await withTenant(db, tenant.tenantId, (tx) => createIn(tx, 'confirmed'));
      const now = await withTenant(db, tenant.tenantId, async (tx) => {
        await tx
          .update(appointments)
          .set({ status: 'cancelled_by_customer', cancelledAt: forged })
          .where(eq(appointments.id, booked.appointmentId));
        return transactionNow(tx);
      });
      expect((await readRow(booked.appointmentId)).cancelledAt?.getTime()).toBe(now);
    });

    it('INSERT ignora instantes de transições que ainda não aconteceram', async () => {
      const { booked, now } = await withTenant(db, tenant.tenantId, async (tx) => ({
        booked: await bookAppointment(tx, tenant, {
          staffId: tenant.staffIds[1],
          ...nextSlot(),
          appointment: {
            confirmedAt: forged,
            checkedInAt: forged,
            startedAt: forged,
            completedAt: forged,
            cancelledAt: forged,
            noShowAt: forged,
            expiredAt: forged,
          },
        }),
        now: await transactionNow(tx),
      }));
      const row = await readRow(booked.appointmentId);
      expect(instantsOf(row)).toEqual({
        holdExpiresAt: null,
        confirmedAt: new Date(now),
        checkedInAt: null,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        noShowAt: null,
        expiredAt: null,
        createdAt: row.createdAt,
      });
    });

    it('o hold só muda enquanto o agendamento está pending', async () => {
      const booked = await withTenant(db, tenant.tenantId, (tx) => createIn(tx, 'pending'));
      const extended = new Date('2098-01-01T00:00:00Z');
      const setHold = (holdExpiresAt: Date) =>
        withTenant(db, tenant.tenantId, (tx) =>
          tx
            .update(appointments)
            .set({ holdExpiresAt })
            .where(eq(appointments.id, booked.appointmentId)),
        );
      await setHold(extended);
      expect((await readRow(booked.appointmentId)).holdExpiresAt).toEqual(extended);
      await withTenant(db, tenant.tenantId, (tx) =>
        tx
          .update(appointments)
          .set({ status: 'confirmed' })
          .where(eq(appointments.id, booked.appointmentId)),
      );
      await setHold(extended);
      expect((await readRow(booked.appointmentId)).holdExpiresAt).toBeNull();
    });

    it('app_worker só altera o status: não forja instantes', async () => {
      const worker = connectAsWorker();
      try {
        const booked = await withTenant(db, tenant.tenantId, (tx) => createIn(tx, 'confirmed'));
        const asWorker = (values: Partial<typeof appointments.$inferInsert>) =>
          withTenant(
            worker,
            tenant.tenantId,
            (tx) =>
              tx.update(appointments).set(values).where(eq(appointments.id, booked.appointmentId)),
            { actor: { type: 'system', id: 'job:no-show' } },
          );
        await expect(asWorker({ status: 'no_show', noShowAt: forged })).rejects.toBeInstanceOf(
          TenantIsolationError,
        );
        await expect(asWorker({ completedAt: forged })).rejects.toBeInstanceOf(
          TenantIsolationError,
        );
        await asWorker({ status: 'no_show' });
        const row = await readRow(booked.appointmentId);
        expect(row.status).toBe('no_show');
        expect(row.noShowAt?.getUTCFullYear()).toBeGreaterThan(2000);
      } finally {
        await worker.$client.end();
      }
    });
  });

  it('lock otimista: UPDATE com version antiga não altera nada', async () => {
    const booked = await withTenant(db, tenant.tenantId, (tx) => createIn(tx, 'confirmed'));
    const update = (version: number) =>
      withTenant(db, tenant.tenantId, (tx) =>
        tx
          .update(appointments)
          .set({ cancellationReason: `edição v${version}` })
          .where(
            sql`${appointments.id} = ${booked.appointmentId} AND ${appointments.version} = ${version}`,
          )
          .returning({ version: appointments.version }),
      );
    expect(await update(1)).toEqual([{ version: 2 }]);
    expect(await update(1)).toEqual([]);
  });
});
