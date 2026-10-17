import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/client';
import { SlotUnavailableError } from '../../src/errors';
import { appointments, occupancies } from '../../src/schema';
import { withTenant } from '../../src/tenant';
import {
  connectAsAdmin,
  connectAsAppUser,
  connectAsWorker,
  sqlStateOf,
} from '../helpers/connections';
import {
  bookAppointment,
  createTenantFixture,
  first,
  type TenantFixture,
} from '../helpers/fixtures';

const at = (iso: string) => new Date(iso);

describe('ocupação do profissional: EXCLUDE anti-overbooking', () => {
  let db: Database;
  let worker: Database;
  let admin: pg.Pool;
  let tenant: TenantFixture;
  let otherTenant: TenantFixture;

  beforeAll(async () => {
    db = connectAsAppUser(8);
    worker = connectAsWorker();
    admin = connectAsAdmin();
    tenant = await createTenantFixture(db);
    otherTenant = await createTenantFixture(db);
  });

  afterAll(async () => {
    await Promise.all([db.$client.end(), worker.$client.end(), admin.end()]);
  });

  function book(
    staffId: string,
    startsAt: string,
    endsAt: string,
    status?: 'pending' | 'confirmed',
  ) {
    return withTenant(db, tenant.tenantId, (tx) =>
      bookAppointment(tx, tenant, {
        staffId,
        startsAt: at(startsAt),
        endsAt: at(endsAt),
        ...(status === undefined ? {} : { status }),
      }),
    );
  }

  function setStatus(appointmentId: string, status: (typeof appointments.$inferSelect)['status']) {
    return withTenant(db, tenant.tenantId, (tx) =>
      tx.update(appointments).set({ status }).where(eq(appointments.id, appointmentId)),
    );
  }

  async function occupancyActive(occupancyId: string): Promise<boolean> {
    const row = first(
      await withTenant(db, tenant.tenantId, (tx) =>
        tx
          .select({ active: occupancies.active })
          .from(occupancies)
          .where(eq(occupancies.id, occupancyId)),
      ),
    );
    return row.active;
  }

  it('sobreposição parcial com o mesmo profissional => 23P01 (SlotUnavailableError)', async () => {
    const [ana] = tenant.staffIds;
    await book(ana, '2027-02-01T13:00:00Z', '2027-02-01T14:00:00Z');
    const conflict = book(ana, '2027-02-01T13:30:00Z', '2027-02-01T14:30:00Z');
    await expect(conflict).rejects.toBeInstanceOf(SlotUnavailableError);
    await expect(conflict).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
      sqlState: '23P01',
      constraint: 'occupancies_no_staff_overlap',
    });
  });

  it('intervalos semiabertos: atendimentos encostados são permitidos', async () => {
    const [ana] = tenant.staffIds;
    await book(ana, '2027-02-02T13:00:00Z', '2027-02-02T14:00:00Z');
    await expect(book(ana, '2027-02-02T14:00:00Z', '2027-02-02T15:00:00Z')).resolves.toBeDefined();
    await expect(book(ana, '2027-02-02T12:00:00Z', '2027-02-02T13:00:00Z')).resolves.toBeDefined();
  });

  it('outro profissional, ou outro tenant, no mesmo horário é permitido', async () => {
    const [ana, bruno] = tenant.staffIds;
    await book(ana, '2027-02-03T13:00:00Z', '2027-02-03T14:00:00Z');
    await expect(
      book(bruno, '2027-02-03T13:00:00Z', '2027-02-03T14:00:00Z'),
    ).resolves.toBeDefined();
    await expect(
      withTenant(db, otherTenant.tenantId, (tx) =>
        bookAppointment(tx, otherTenant, {
          staffId: otherTenant.staffIds[0],
          startsAt: at('2027-02-03T13:00:00Z'),
          endsAt: at('2027-02-03T14:00:00Z'),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('cancelado não bloqueia: o trigger desativa a ocupação e o horário volta a ser reservável', async () => {
    const [ana] = tenant.staffIds;
    const original = await book(ana, '2027-02-04T13:00:00Z', '2027-02-04T14:00:00Z');
    await setStatus(original.appointmentId, 'cancelled_by_customer');
    expect(await occupancyActive(original.occupancyId)).toBe(false);
    const second = await book(ana, '2027-02-04T13:00:00Z', '2027-02-04T14:00:00Z');
    expect(await occupancyActive(second.occupancyId)).toBe(true);
  });

  it('no-show libera o horário para encaixe', async () => {
    const [ana] = tenant.staffIds;
    const missed = await book(ana, '2027-02-05T13:00:00Z', '2027-02-05T14:00:00Z');
    await setStatus(missed.appointmentId, 'no_show');
    expect(await occupancyActive(missed.occupancyId)).toBe(false);
    await expect(book(ana, '2027-02-05T13:30:00Z', '2027-02-05T14:00:00Z')).resolves.toBeDefined();
  });

  it('`active` é derivada do status: o valor enviado pela aplicação é ignorado', async () => {
    const [, bruno] = tenant.staffIds;
    const booked = await withTenant(db, tenant.tenantId, async (tx) => {
      const created = await bookAppointment(tx, tenant, {
        staffId: bruno,
        startsAt: at('2027-02-06T13:00:00Z'),
        endsAt: at('2027-02-06T14:00:00Z'),
      });
      // Tentativa de "esconder" a ocupação do EXCLUDE.
      await tx
        .update(occupancies)
        .set({ active: false })
        .where(eq(occupancies.id, created.occupancyId));
      return created;
    });
    expect(await occupancyActive(booked.occupancyId)).toBe(true);
    await expect(
      book(bruno, '2027-02-06T13:00:00Z', '2027-02-06T14:00:00Z'),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
  });

  it('reativar hold expirado com o horário já tomado => SlotUnavailableError (Pix pago tarde)', async () => {
    const [ana] = tenant.staffIds;
    const hold = await book(ana, '2027-02-08T13:00:00Z', '2027-02-08T14:00:00Z', 'pending');
    // O job de expiração roda como app_worker.
    await withTenant(
      worker,
      tenant.tenantId,
      (tx) =>
        tx
          .update(appointments)
          .set({ status: 'expired' })
          .where(eq(appointments.id, hold.appointmentId)),
      { actor: { type: 'system', id: 'job:expire-holds' } },
    );
    expect(await occupancyActive(hold.occupancyId)).toBe(false);
    await book(ana, '2027-02-08T13:00:00Z', '2027-02-08T14:00:00Z');
    await expect(setStatus(hold.appointmentId, 'confirmed')).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
    // A falha desfaz tudo: o agendamento continua expirado e sem ocupar a agenda.
    const row = first(
      await withTenant(db, tenant.tenantId, (tx) =>
        tx
          .select({ status: appointments.status })
          .from(appointments)
          .where(eq(appointments.id, hold.appointmentId)),
      ),
    );
    expect(row.status).toBe('expired');
    expect(await occupancyActive(hold.occupancyId)).toBe(false);
  });

  it('corrida controlada: a 2ª transação espera o commit da 1ª e então recebe 23P01', async () => {
    const [ana] = tenant.staffIds;
    const firstClient = await db.$client.connect();
    const secondClient = await db.$client.connect();
    const insertOccupancy = (client: pg.PoolClient, appointmentId: string, itemId: string) =>
      client.query(
        `INSERT INTO app.occupancies (appointment_id, appointment_item_id, staff_id, starts_at, ends_at)
         VALUES ($1, $2, $3, '2027-02-09T13:00:00Z', '2027-02-09T14:00:00Z')`,
        [appointmentId, itemId, ana],
      );
    try {
      // Dois agendamentos sem ocupação, criados antes; a corrida é só no INSERT da ocupação.
      const slots = await withTenant(db, tenant.tenantId, async (tx) => {
        const one = await bookAppointment(tx, tenant, {
          staffId: tenant.staffIds[1],
          startsAt: at('2027-02-09T13:00:00Z'),
          endsAt: at('2027-02-09T14:00:00Z'),
        });
        const two = await bookAppointment(tx, tenant, {
          staffId: tenant.staffIds[1],
          startsAt: at('2027-02-09T15:00:00Z'),
          endsAt: at('2027-02-09T16:00:00Z'),
        });
        return [one, two] as const;
      });
      for (const client of [firstClient, secondClient]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.tenantId]);
      }
      const { rows: pidRows } = await secondClient.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      const secondPid = pidRows[0]?.pid;

      await insertOccupancy(firstClient, slots[0].appointmentId, slots[0].itemId);
      const pending = insertOccupancy(secondClient, slots[1].appointmentId, slots[1].itemId).then(
        () => 'committed-without-conflict',
        (error: unknown) => sqlStateOf(error),
      );

      // Sincronização sem sleep: espera a 2ª sessão ficar bloqueada aguardando lock.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await admin.query<{ waiting: boolean }>(
          "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
          [secondPid],
        );
        if (rows[0]?.waiting === true) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const { rows: waitRows } = await admin.query<{ waiting: boolean }>(
        "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
        [secondPid],
      );
      expect(waitRows[0]?.waiting).toBe(true);

      await firstClient.query('COMMIT');
      expect(await pending).toBe('23P01');
      await secondClient.query('ROLLBACK');
    } finally {
      firstClient.release();
      secondClient.release();
    }
  });

  it('corrida real: N reservas simultâneas do mesmo horário => exatamente uma vence', async () => {
    const [, bruno] = tenant.staffIds;
    const attempts = 6;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        book(bruno, '2027-02-10T13:00:00Z', '2027-02-10T14:00:00Z'),
      ),
    );
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(attempts - 1);
    for (const loser of losers) {
      expect(loser.reason).toBeInstanceOf(SlotUnavailableError);
    }
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.occupancies
        WHERE tenant_id = $1 AND staff_id = $2 AND active
          AND during && tstzrange('2027-02-10T13:00:00Z', '2027-02-10T14:00:00Z')`,
      [tenant.tenantId, bruno],
    );
    expect(rows[0]?.n).toBe(1);
  });
});
