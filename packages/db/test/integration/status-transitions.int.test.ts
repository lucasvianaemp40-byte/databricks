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
import { findPostgresError, InvalidStatusTransitionError } from '../../src/errors';
import { appointmentEvents, appointments, occupancies } from '../../src/schema';
import { type TenantTransaction, withTenant } from '../../src/tenant';
import { connectAsAppUser } from '../helpers/connections';
import {
  bookAppointment,
  createTenantFixture,
  first,
  randomIdempotencyKey,
  type TenantFixture,
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
      const attempt = withTenant(db, tenant.tenantId, (tx) =>
        tx.insert(appointments).values({
          locationId: tenant.locationId,
          customerId: tenant.customerId,
          status,
          source: 'staff',
          ...nextSlot(),
          localStartsAt: '2027-06-01 09:00:00',
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
