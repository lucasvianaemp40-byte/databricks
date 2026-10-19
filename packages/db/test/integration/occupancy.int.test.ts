import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/client';
import { PG_ERROR, SlotUnavailableError, TenantIsolationError } from '../../src/errors';
import { appointmentItems, appointments, locations, occupancies } from '../../src/schema';
import { withTenant } from '../../src/tenant';
import {
  captureDatabaseError,
  captureSqlState,
  connectAsAdmin,
  connectAsAppUser,
  connectAsWorker,
  sqlStateOf,
} from '../helpers/connections';
import {
  bookAppointment,
  createTenantFixture,
  first,
  randomIdempotencyKey,
  type TenantFixture,
  TIMEZONE,
  utcOffsetSeconds,
  wallTime,
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
    const startsAt = at('2027-02-09T13:00:00Z');
    const endsAt = at('2027-02-09T14:00:00Z');
    const firstClient = await db.$client.connect();
    const secondClient = await db.$client.connect();
    // Reserva completa (visita, item e ocupação) pelo SQL da aplicação, em sessão própria.
    const bookVia = async (client: pg.PoolClient) => {
      const appointment = first(
        (
          await client.query<{ id: string }>(
            `INSERT INTO app.appointments (location_id, customer_id, status, source, starts_at,
                ends_at, local_starts_at, local_utc_offset_seconds, timezone, idempotency_key)
             VALUES ($1, $2, 'confirmed', 'staff', $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              tenant.locationId,
              tenant.customerId,
              startsAt,
              endsAt,
              wallTime(startsAt),
              utcOffsetSeconds(startsAt),
              TIMEZONE,
              randomIdempotencyKey(),
            ],
          )
        ).rows,
      );
      const item = first(
        (
          await client.query<{ id: string }>(
            `INSERT INTO app.appointment_items (appointment_id, position, service_id, staff_id,
                service_name, duration_min, phases, price_cents, commission_bps, starts_at, ends_at)
             VALUES ($1, 1, $2, $3, 'Corte', 60, '[{"kind": "work", "minutes": 60}]', 6000, 4000,
                     $4, $5) RETURNING id`,
            [appointment.id, tenant.serviceId, ana, startsAt, endsAt],
          )
        ).rows,
      );
      return client.query(
        `INSERT INTO app.occupancies (appointment_id, appointment_item_id, staff_id, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [appointment.id, item.id, ana, startsAt, endsAt],
      );
    };
    try {
      for (const client of [firstClient, secondClient]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.tenantId]);
      }
      const { rows: pidRows } = await secondClient.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      const secondPid = pidRows[0]?.pid;

      await bookVia(firstClient);
      const pending = bookVia(secondClient).then(
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

/**
 * A ocupação é a prova, no banco, de que o profissional está ocupado. A aplicação não consegue
 * escondê-la (DELETE, UPDATE de profissional/horário/item), nem gravá-la incoerente com o item,
 * nem confirmar um agendamento cujo item ficou sem ocupação.
 */
describe('ocupação amarrada ao item: a aplicação não esconde nem desalinha a agenda', () => {
  let db: Database;
  let worker: Database;
  let tenant: TenantFixture;
  let day = 0;

  beforeAll(async () => {
    db = connectAsAppUser();
    worker = connectAsWorker();
    tenant = await createTenantFixture(db);
  });

  afterAll(async () => {
    await Promise.all([db.$client.end(), worker.$client.end()]);
  });

  /** Um dia próprio por teste (13:00-14:00Z): nenhum teste colide com outro. */
  function nextWindow() {
    day += 1;
    const startsAt = new Date(Date.UTC(2027, 7, day, 13, 0));
    return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000) };
  }

  const minutes = (instant: Date, delta: number) => new Date(instant.getTime() + delta * 60_000);

  function book(window = nextWindow(), extra: Partial<Parameters<typeof bookAppointment>[2]> = {}) {
    return withTenant(db, tenant.tenantId, (tx) =>
      bookAppointment(tx, tenant, { staffId: tenant.staffIds[0], ...window, ...extra }),
    );
  }

  function insertOccupancy(
    booked: { appointmentId: string; itemId: string },
    values: { staffId?: string; startsAt: Date; endsAt: Date; kind?: 'service' | 'buffer' },
  ) {
    return withTenant(db, tenant.tenantId, (tx) =>
      tx.insert(occupancies).values({
        appointmentId: booked.appointmentId,
        appointmentItemId: booked.itemId,
        staffId: values.staffId ?? tenant.staffIds[0],
        kind: values.kind ?? 'service',
        startsAt: values.startsAt,
        endsAt: values.endsAt,
      }),
    );
  }

  it('app_user não apaga a ocupação de um agendamento (o horário continuaria "livre")', async () => {
    const window = nextWindow();
    const booked = await book(window);
    await expect(
      withTenant(db, tenant.tenantId, (tx) =>
        tx.delete(occupancies).where(eq(occupancies.id, booked.occupancyId)),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(book(window)).rejects.toBeInstanceOf(SlotUnavailableError);
  });

  it.each([
    ['profissional', { staffId: 'outro' }],
    ['horário', { startsAt: new Date('2031-01-01T00:00:00Z') }],
    ['item (re-apontar para outro agendamento)', { appointmentItemId: 'outro' }],
  ] as const)('app_user e app_worker não mudam o %s da ocupação', async (_label, change) => {
    const booked = await book();
    const other = await book();
    const values = {
      ...('staffId' in change ? { staffId: tenant.staffIds[1] } : {}),
      ...('startsAt' in change ? { startsAt: change.startsAt } : {}),
      ...('appointmentItemId' in change
        ? { appointmentId: other.appointmentId, appointmentItemId: other.itemId }
        : {}),
    };
    for (const connection of [db, worker]) {
      await expect(
        withTenant(connection, tenant.tenantId, (tx) =>
          tx.update(occupancies).set(values).where(eq(occupancies.id, booked.occupancyId)),
        ),
      ).rejects.toBeInstanceOf(TenantIsolationError);
    }
  });

  it('ocupação de outro profissional que não o do item => 23503', async () => {
    const window = nextWindow();
    const booked = await book(window);
    expect(
      await captureSqlState(
        insertOccupancy(booked, {
          staffId: tenant.staffIds[1],
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        }),
      ),
    ).toBe(PG_ERROR.foreignKeyViolation);
  });

  it('ocupação fora da janela do item => 23514 occupancies_within_item', async () => {
    const window = nextWindow();
    const booked = await book(window, {
      item: {
        phases: [
          { kind: 'work', minutes: 30 },
          { kind: 'pause', minutes: 30 },
        ],
      },
      occupancies: [{ startsAt: window.startsAt, endsAt: minutes(window.startsAt, 30) }],
    });
    const attempt = insertOccupancy(booked, {
      startsAt: minutes(window.startsAt, 30),
      endsAt: minutes(window.endsAt, 1),
    });
    expect(await captureDatabaseError(attempt)).toMatchObject({
      code: PG_ERROR.checkViolation,
      constraint: 'occupancies_within_item',
    });
    await expect(
      insertOccupancy(booked, { startsAt: minutes(window.startsAt, 30), endsAt: window.endsAt }),
    ).resolves.toBeDefined();
  });

  it('buffer cabe só na janela do item ampliada pelos buffers congelados no item', async () => {
    const window = nextWindow();
    const booked = await book(window, { item: { bufferBeforeMin: 10, bufferAfterMin: 15 } });
    expect(
      await captureDatabaseError(
        insertOccupancy(booked, {
          kind: 'buffer',
          startsAt: window.endsAt,
          endsAt: minutes(window.endsAt, 16),
        }),
      ),
    ).toMatchObject({ code: PG_ERROR.checkViolation, constraint: 'occupancies_within_item' });
    await expect(
      insertOccupancy(booked, {
        kind: 'buffer',
        startsAt: minutes(window.startsAt, -10),
        endsAt: window.startsAt,
      }),
    ).resolves.toBeDefined();
    await expect(
      insertOccupancy(booked, {
        kind: 'buffer',
        startsAt: window.endsAt,
        endsAt: minutes(window.endsAt, 15),
      }),
    ).resolves.toBeDefined();
    // Ocupação "service" só no trecho de buffer não prova o atendimento.
    const other = await book(nextWindow(), { item: { bufferAfterMin: 15 } });
    expect(
      await captureSqlState(
        withTenant(db, tenant.tenantId, async (tx) => {
          const [row] = await tx
            .select({ endsAt: appointmentItems.endsAt })
            .from(appointmentItems)
            .where(eq(appointmentItems.id, other.itemId));
          const endsAt = row?.endsAt ?? new Date(0);
          return tx.insert(occupancies).values({
            appointmentId: other.appointmentId,
            appointmentItemId: other.itemId,
            staffId: tenant.staffIds[0],
            kind: 'service',
            startsAt: endsAt,
            endsAt: minutes(endsAt, 15),
          });
        }),
      ),
    ).toBe(PG_ERROR.checkViolation);
  });

  it('agendamento que ocupa a agenda não faz commit com item sem ocupação', async () => {
    const attempt = withTenant(db, tenant.tenantId, (tx) =>
      bookAppointment(tx, tenant, {
        staffId: tenant.staffIds[0],
        ...nextWindow(),
        occupancies: [],
      }),
    );
    expect(await captureDatabaseError(attempt)).toMatchObject({
      code: PG_ERROR.checkViolation,
      constraint: 'appointments_occupancy_required',
    });
  });

  it('agendamento que ocupa a agenda não faz commit sem nenhum item', async () => {
    const window = nextWindow();
    const attempt = withTenant(db, tenant.tenantId, (tx) =>
      tx.insert(appointments).values({
        locationId: tenant.locationId,
        customerId: tenant.customerId,
        status: 'confirmed',
        source: 'staff',
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        localStartsAt: wallTime(window.startsAt),
        localUtcOffsetSeconds: utcOffsetSeconds(window.startsAt),
        timezone: TIMEZONE,
        idempotencyKey: randomIdempotencyKey(),
      }),
    );
    expect(await captureDatabaseError(attempt)).toMatchObject({
      code: PG_ERROR.checkViolation,
      constraint: 'appointments_occupancy_required',
    });
  });

  it('as ocupações `service` precisam cobrir as fases de trabalho do item (1 minuto não basta)', async () => {
    const window = nextWindow();
    expect(
      await captureDatabaseError(
        book(window, {
          occupancies: [{ startsAt: window.startsAt, endsAt: minutes(window.startsAt, 1) }],
        }),
      ),
    ).toMatchObject({
      code: PG_ERROR.checkViolation,
      constraint: 'appointments_occupancy_required',
    });
    // O resto da hora continua livre para o EXCLUDE: nada foi gravado.
    await expect(book(window)).resolves.toBeDefined();
  });

  it('serviço multi-etapa: cada fase de trabalho precisa de cobertura, não só a primeira', async () => {
    const window = nextWindow();
    const attempt = book(window, {
      item: {
        phases: [
          { kind: 'work', minutes: 30 },
          { kind: 'pause', minutes: 20 },
          { kind: 'work', minutes: 10 },
        ],
      },
      // Só a 1ª fase coberta: os 10 minutos finais de trabalho ficariam fora do EXCLUDE.
      occupancies: [{ startsAt: window.startsAt, endsAt: minutes(window.startsAt, 30) }],
    });
    expect(await captureDatabaseError(attempt)).toMatchObject({
      code: PG_ERROR.checkViolation,
      constraint: 'appointments_occupancy_required',
    });
  });

  it('ocupação `buffer` não cobre fase de trabalho', async () => {
    const window = nextWindow();
    const attempt = book(window, {
      occupancies: [{ startsAt: window.startsAt, endsAt: window.endsAt, kind: 'buffer' }],
    });
    expect(await captureDatabaseError(attempt)).toMatchObject({
      code: PG_ERROR.checkViolation,
      constraint: 'appointments_occupancy_required',
    });
  });

  it('item novo numa visita já confirmada (outra transação) também precisa de ocupação', async () => {
    const window = nextWindow();
    const booked = await book(window);
    const [, bruno] = tenant.staffIds;
    const addItem = (withOccupancy: boolean) =>
      withTenant(db, tenant.tenantId, async (tx) => {
        const item = first(
          await tx
            .insert(appointmentItems)
            .values({
              appointmentId: booked.appointmentId,
              position: 2,
              serviceId: tenant.serviceId,
              staffId: bruno,
              serviceName: 'Corte',
              durationMin: 60,
              phases: [{ kind: 'work', minutes: 60 }],
              priceCents: 6000,
              commissionBps: 4000,
              ...window,
            })
            .returning({ id: appointmentItems.id }),
        );
        if (withOccupancy) {
          await tx.insert(occupancies).values({
            appointmentId: booked.appointmentId,
            appointmentItemId: item.id,
            staffId: bruno,
            ...window,
          });
        }
      });
    // A visita já passou pela conferência no INSERT dela; o item tardio é conferido no COMMIT.
    expect(await captureDatabaseError(addItem(false))).toMatchObject({
      code: PG_ERROR.checkViolation,
      constraint: 'appointments_occupancy_required',
    });
    // Controle: o mesmo item, com a ocupação do profissional, entra (a recusa era a ocupação).
    await expect(addItem(true)).resolves.toBeUndefined();
  });

  it('serviço com pausa: ocupa só as fases de trabalho e libera a pausa para outro cliente', async () => {
    const window = nextWindow();
    await book(window, {
      item: {
        phases: [
          { kind: 'work', minutes: 30 },
          { kind: 'pause', minutes: 20 },
          { kind: 'work', minutes: 10 },
        ],
      },
      occupancies: [
        { startsAt: window.startsAt, endsAt: minutes(window.startsAt, 30) },
        { startsAt: minutes(window.startsAt, 50), endsAt: window.endsAt },
      ],
    });
    await expect(
      book({ startsAt: minutes(window.startsAt, 30), endsAt: minutes(window.startsAt, 50) }, {}),
    ).resolves.toBeDefined();
  });

  it('duração congelada no item é a da janela visível', async () => {
    const window = nextWindow();
    expect(
      await captureDatabaseError(
        book(window, { item: { durationMin: 45, phases: [{ kind: 'work', minutes: 45 }] } }),
      ),
    ).toMatchObject({
      code: PG_ERROR.checkViolation,
      constraint: 'appointment_items_duration_coherent',
    });
  });

  it('item fora da janela da visita não faz commit', async () => {
    const window = nextWindow();
    const later = { startsAt: minutes(window.startsAt, 120), endsAt: minutes(window.endsAt, 120) };
    expect(
      await captureDatabaseError(
        book(later, {
          appointment: {
            startsAt: window.startsAt,
            endsAt: window.endsAt,
            localStartsAt: wallTime(window.startsAt),
            localUtcOffsetSeconds: utcOffsetSeconds(window.startsAt),
          },
        }),
      ),
    ).toMatchObject({
      code: PG_ERROR.checkViolation,
      constraint: 'appointments_occupancy_required',
    });
  });

  it('a visita não muda de horário, unidade nem fuso (remarcar = novo agendamento)', async () => {
    const booked = await book();
    // Outra unidade do MESMO salão e no MESMO fuso: o caso isola a troca de unidade.
    const otherLocation = first(
      await withTenant(db, tenant.tenantId, (tx) =>
        tx
          .insert(locations)
          .values({ name: 'Filial', slug: 'filial-imutavel', timezone: TIMEZONE })
          .returning({ id: locations.id }),
      ),
    );
    const moved = new Date('2031-01-01T12:00:00Z');
    for (const change of [
      { startsAt: moved, localStartsAt: wallTime(moved) },
      { endsAt: new Date('2031-01-01T13:00:00Z') },
      { localUtcOffsetSeconds: -4 * 60 * 60, localStartsAt: '2000-01-01 00:00:00' },
      { timezone: 'America/Manaus' },
      { locationId: otherLocation.id },
    ]) {
      expect(
        await captureDatabaseError(
          withTenant(db, tenant.tenantId, (tx) =>
            tx.update(appointments).set(change).where(eq(appointments.id, booked.appointmentId)),
          ),
        ),
      ).toMatchObject({
        code: PG_ERROR.checkViolation,
        constraint: 'appointments_schedule_immutable',
      });
    }
  });

  it('item não muda de profissional, horário, fases nem buffers (remarcar = novo agendamento)', async () => {
    const booked = await book();
    for (const change of [
      { staffId: tenant.staffIds[1] },
      { startsAt: new Date('2031-01-01T00:00:00Z'), endsAt: new Date('2031-01-01T01:00:00Z') },
      { durationMin: 30, phases: [{ kind: 'work' as const, minutes: 30 }] },
      // Mesma duração (60): só as fases mudam. [work 10, pause 50] -> [work 60] deixaria 50
      // minutos de trabalho sem ocupação, porque a cobertura não é reconferida no UPDATE.
      {
        phases: [
          { kind: 'work' as const, minutes: 10 },
          { kind: 'pause' as const, minutes: 50 },
        ],
      },
      { bufferBeforeMin: 10 },
      { bufferAfterMin: 10 },
    ]) {
      expect(
        await captureDatabaseError(
          withTenant(db, tenant.tenantId, (tx) =>
            tx.update(appointmentItems).set(change).where(eq(appointmentItems.id, booked.itemId)),
          ),
        ),
      ).toMatchObject({
        code: PG_ERROR.checkViolation,
        constraint: 'appointment_items_schedule_immutable',
      });
    }
  });

  it('item com ocupação ativa não é apagado; depois de cancelar, pode ser', async () => {
    const window = nextWindow();
    const booked = await book(window);
    const removeItem = () =>
      withTenant(db, tenant.tenantId, (tx) =>
        tx.delete(appointmentItems).where(eq(appointmentItems.id, booked.itemId)),
      );
    expect(await captureDatabaseError(removeItem())).toMatchObject({
      code: PG_ERROR.checkViolation,
      constraint: 'appointment_items_schedule_immutable',
    });
    await expect(book(window)).rejects.toBeInstanceOf(SlotUnavailableError);
    await withTenant(db, tenant.tenantId, (tx) =>
      tx
        .update(appointments)
        .set({ status: 'cancelled_by_salon' })
        .where(eq(appointments.id, booked.appointmentId)),
    );
    await expect(removeItem()).resolves.toBeDefined();
  });
});
