import { assertIanaTimeZone, OCCUPANCY_KINDS, type ServicePhase } from '@salon/scheduling-core';
import { asc, eq, inArray } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/client';
import { findPostgresError, IdempotencyKeyConflictError, PG_ERROR } from '../../src/errors';
import { appointments, customers, locations, services, workingHours } from '../../src/schema';
import { withTenant } from '../../src/tenant';
import {
  captureDatabaseError,
  captureSqlState,
  connectAsAdmin,
  connectAsAppUser,
} from '../helpers/connections';
import {
  bookAppointment,
  createTenantFixture,
  first,
  randomIdempotencyKey,
  type TenantFixture,
} from '../helpers/fixtures';

describe('integridade do schema (CHECK, UNIQUE, EXCLUDE)', () => {
  let db: Database;
  let tenant: TenantFixture;
  let otherTenant: TenantFixture;

  beforeAll(async () => {
    db = connectAsAppUser();
    tenant = await createTenantFixture(db);
    otherTenant = await createTenantFixture(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(db, tenant.tenantId, fn);

  describe('fuso IANA da unidade', () => {
    it.each([
      'America/Sao_Paulo',
      'America/Manaus',
      'America/Noronha',
      'America/Rio_Branco',
      'Etc/UTC',
      'America/Port-au-Prince',
      'America/Argentina/Buenos_Aires',
    ])('aceita %s', async (timezone) => {
      expect(() => assertIanaTimeZone(timezone)).not.toThrow();
      await expect(
        inTenant((tx) =>
          tx.insert(locations).values({
            name: timezone,
            slug: timezone.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'),
            timezone,
          }),
        ),
      ).resolves.toBeDefined();
    });

    it.each([
      'Brasil/Brasilia',
      'UTC-3',
      '-03:00',
      'BRT',
      'America/Atlantida',
      '',
      'America/Sao_Paulo; DROP TABLE x',
      // Fora do tzdata, o PostgreSQL leria estes nomes como especificação POSIX (offset fixo,
      // sem horário de verão do tzdata) e o core os recusaria.
      'Abc/Def3',
      'Brasilia/Horario+3',
      'America/Sao_Paulo3',
      'America/Sao_Paulo3BRST',
      'America/Fake-3',
      'Mars/Base+03',
      // Existem no tzdata, mas são offset fixo (proibido pela regra de fuso do projeto).
      'Etc/GMT+3',
      'Etc/GMT-14',
      'Etc/GMT0',
      // Sem "Área/": use 'Etc/UTC'.
      'UTC',
      'GMT',
      'America/Sao_Paulo/',
      // Acima do teto de 64 caracteres.
      `America/${'A'.repeat(57)}`,
    ])('recusa %j', async (timezone) => {
      // O core recusa o mesmo nome antes de chegar ao banco.
      expect(() => assertIanaTimeZone(timezone)).toThrow();
      expect(
        await captureSqlState(
          inTenant((tx) =>
            tx.insert(locations).values({ name: 'Inválida', slug: 'invalida', timezone }),
          ),
        ),
      ).toBe(PG_ERROR.checkViolation);
    });
  });

  it('paridade com o core: todo fuso que o banco aceita o assertIanaTimeZone também aceita', async () => {
    const admin = connectAsAdmin(1);
    try {
      const { rows } = await admin.query<{ name: string }>(
        `SELECT name FROM pg_catalog.pg_timezone_names
          WHERE app_private.is_valid_iana_timezone(name) ORDER BY name`,
      );
      expect(rows.length).toBeGreaterThan(300);
      const rejectedByCore = rows
        .map((row) => row.name)
        .filter((name) => {
          try {
            assertIanaTimeZone(name);
            return false;
          } catch {
            return true;
          }
        });
      expect(rejectedByCore).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('paridade com o core: fusos reais (os 16 do Brasil e os dos testes do core) passam nos dois lados', async () => {
    // Amostra fixa de nomes canônicos. Intl.supportedValuesOf('timeZone') NÃO serve: o ICU lista
    // links legados (US/Eastern, Brazil/East...) que um PostgreSQL sem tzdata-legacy recusa.
    const sample = [
      'America/Noronha',
      'America/Belem',
      'America/Fortaleza',
      'America/Recife',
      'America/Araguaina',
      'America/Maceio',
      'America/Bahia',
      'America/Sao_Paulo',
      'America/Campo_Grande',
      'America/Cuiaba',
      'America/Santarem',
      'America/Porto_Velho',
      'America/Boa_Vista',
      'America/Manaus',
      'America/Eirunepe',
      'America/Rio_Branco',
      'Etc/UTC',
      'America/New_York',
      'America/Santiago',
      'Europe/Lisbon',
      'Europe/London',
      'Australia/Lord_Howe',
      'Pacific/Chatham',
      'Asia/Kathmandu',
      'Pacific/Kiritimati',
      'Pacific/Apia',
      'America/St_Johns',
      'America/Goose_Bay',
      'America/Moncton',
      'Antarctica/Casey',
    ];
    const rejectedByCore = sample.filter((name) => {
      try {
        assertIanaTimeZone(name);
        return false;
      } catch {
        return true;
      }
    });
    expect(rejectedByCore).toEqual([]);
    const admin = connectAsAdmin(1);
    try {
      const { rows } = await admin.query<{ name: string; valid: boolean }>(
        `SELECT name, app_private.is_valid_iana_timezone(name) AS valid
           FROM unnest($1::text[]) AS name`,
        [sample],
      );
      expect(rows).toHaveLength(sample.length);
      expect(rows.filter((row) => !row.valid).map((row) => row.name)).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('paridade com o core: o banco aceita em occupancies.kind exatamente OCCUPANCY_KINDS', async () => {
    // Catálogo do banco migrado, não o texto da migração: vale o que está aplicado. Todo CHECK
    // de occupancies que cite `kind` entra, para que nenhum outro restrinja os tipos em silêncio.
    const { rows } = await db.$client.query<{ name: string; definition: string }>(
      `SELECT c.conname AS name, pg_catalog.pg_get_constraintdef(c.oid) AS definition
         FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'app.occupancies'::regclass
          AND c.contype = 'c'
          AND c.convalidated
          AND pg_catalog.pg_get_constraintdef(c.oid) ~ '\\mkind\\M'`,
    );
    expect(rows.map((row) => row.name)).toEqual(['occupancies_kind_valid']);
    const definition = first(rows).definition;
    // O PostgreSQL normaliza `kind IN (...)` para `kind = ANY (ARRAY['service'::text, ...])`.
    expect(definition).toMatch(/^CHECK \(\(kind = ANY \(ARRAY\[[^\]]*\]\)\)\)$/);
    const kinds = [...definition.matchAll(/'([^']*)'::text/g)].map(([, kind]) => kind ?? '');
    expect(kinds.sort()).toEqual([...OCCUPANCY_KINDS].sort());
  });

  describe('fases do serviço', () => {
    const insertService = (durationMin: number, phases: unknown) =>
      inTenant((tx) =>
        tx.insert(services).values({
          name: 'Coloração',
          durationMin,
          phases: phases as ServicePhase[],
          priceCents: 25000,
        }),
      );

    it('aceita multi-etapa com pausa (profissional livre no meio)', async () => {
      await expect(
        insertService(100, [
          { kind: 'work', minutes: 30 },
          { kind: 'pause', minutes: 40 },
          { kind: 'work', minutes: 30 },
        ]),
      ).resolves.toBeDefined();
    });

    it.each([
      ['soma diferente da duração', 60, [{ kind: 'work', minutes: 30 }]],
      ['nenhuma fase de trabalho', 30, [{ kind: 'pause', minutes: 30 }]],
      ['tipo de fase desconhecido', 30, [{ kind: 'rest', minutes: 30 }]],
      [
        'minutos fracionados',
        30,
        [
          { kind: 'work', minutes: 29.5 },
          { kind: 'work', minutes: 0.5 },
        ],
      ],
      ['minutos como texto', 30, [{ kind: 'work', minutes: '30' }]],
      ['chave extra', 30, [{ kind: 'work', minutes: 30, note: 'x' }]],
      ['formato antigo (staffBusy)', 30, [{ minutes: 30, staffBusy: true }]],
      ['lista vazia', 30, []],
      ['não é lista', 30, { kind: 'work', minutes: 30 }],
      ['elemento escalar', 30, [30]],
      [
        'fase zerada',
        30,
        [
          { kind: 'pause', minutes: 0 },
          { kind: 'work', minutes: 30 },
        ],
      ],
    ])('recusa %s', async (_label, durationMin, phases) => {
      expect(await captureSqlState(insertService(durationMin, phases))).toBe(
        PG_ERROR.checkViolation,
      );
    });
  });

  describe('jornada semanal', () => {
    const insertHours = (
      weekday: number,
      startTime: string,
      endTime: string,
      validFrom = '2026-01-01',
    ) =>
      inTenant((tx) =>
        tx.insert(workingHours).values({
          staffId: tenant.staffIds[1],
          locationId: tenant.locationId,
          weekday,
          startTime,
          endTime,
          validFrom,
        }),
      );

    it('almoço (duas faixas no mesmo dia) é permitido; sobreposição => 23P01', async () => {
      await expect(insertHours(3, '09:00', '12:00')).resolves.toBeDefined();
      await expect(insertHours(3, '13:00', '19:00')).resolves.toBeDefined();
      await expect(insertHours(3, '12:00', '13:00')).resolves.toBeDefined();
      expect(await captureSqlState(insertHours(3, '11:00', '14:00', '2026-06-01'))).toBe(
        PG_ERROR.exclusionViolation,
      );
      await expect(insertHours(4, '11:00', '14:00')).resolves.toBeDefined();
    });

    it.each([
      ['dia 0', 0, '09:00', '10:00'],
      ['dia 8', 8, '09:00', '10:00'],
      ['fim antes do início', 5, '10:00', '09:00'],
      // O core só representa 'HH:MM': segundos derrubariam ou deslocariam a agenda.
      ['início com segundos', 1, '09:00:30', '18:00'],
      ['fim com fração de segundo', 1, '09:00', '18:00:00.5'],
    ])('recusa %s', async (_label, weekday, start, end) => {
      expect(await captureSqlState(insertHours(weekday, start, end))).toBe(PG_ERROR.checkViolation);
    });

    it('aceita turno até 24:00', async () => {
      await expect(insertHours(2, '18:00', '24:00')).resolves.toBeDefined();
    });
  });

  describe('clientes (LGPD e unicidade por tenant)', () => {
    it('telefone é único por tenant, mas o mesmo número existe em outro salão', async () => {
      const phone = '+5521988887777';
      await inTenant((tx) => tx.insert(customers).values({ fullName: 'Maria', phoneE164: phone }));
      expect(
        await captureSqlState(
          inTenant((tx) => tx.insert(customers).values({ fullName: 'Maria 2', phoneE164: phone })),
        ),
      ).toBe(PG_ERROR.uniqueViolation);
      await expect(
        withTenant(db, otherTenant.tenantId, (tx) =>
          tx.insert(customers).values({ fullName: 'Maria', phoneE164: phone }),
        ),
      ).resolves.toBeDefined();
    });

    it.each(['11999990000', '+0551199999000', '+55 11 99999-0000', '+55'])(
      'recusa telefone fora de E.164: %s',
      async (phone) => {
        expect(
          await captureSqlState(
            inTenant((tx) => tx.insert(customers).values({ fullName: 'X', phoneE164: phone })),
          ),
        ).toBe(PG_ERROR.checkViolation);
      },
    );

    it('e-mail precisa estar em minúsculas e ter formato plausível', async () => {
      expect(
        await captureSqlState(
          inTenant((tx) =>
            tx.insert(customers).values({ fullName: 'X', email: 'Ana@Exemplo.com' }),
          ),
        ),
      ).toBe(PG_ERROR.checkViolation);
      await expect(
        inTenant((tx) =>
          tx.insert(customers).values({ fullName: 'X', email: 'ana@exemplo.com.br' }),
        ),
      ).resolves.toBeDefined();
    });

    it('anonimizar exige apagar contato e consentimentos', async () => {
      const created = first(
        await inTenant((tx) =>
          tx
            .insert(customers)
            .values({
              fullName: 'Titular',
              phoneE164: '+5531977776666',
              whatsappOptInAt: new Date(),
            })
            .returning({ id: customers.id }),
        ),
      );
      expect(
        await captureSqlState(
          inTenant((tx) =>
            tx
              .update(customers)
              .set({ anonymizedAt: new Date() })
              .where(eq(customers.id, created.id)),
          ),
        ),
      ).toBe(PG_ERROR.checkViolation);
      await expect(
        inTenant((tx) =>
          tx
            .update(customers)
            .set({
              anonymizedAt: new Date(),
              fullName: 'Titular anonimizado',
              phoneE164: null,
              whatsappOptInAt: null,
            })
            .where(eq(customers.id, created.id)),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('instantes com precisão de milissegundo (o Date do driver não carrega microssegundos)', () => {
    it.each(['appointments', 'appointment_items', 'occupancies', 'time_off'])(
      '%s recusa microssegundos',
      async (table) => {
        const admin = connectAsAdmin(1);
        const client = await admin.connect();
        try {
          await client.query('BEGIN');
          // Modo réplica desliga os triggers: isola o CHECK de precisão das demais regras.
          await client.query('SET LOCAL session_replication_role = replica');
          const error = await client
            .query(
              `UPDATE app.${pg.escapeIdentifier(table)}
                  SET starts_at = starts_at + interval '1 microsecond',
                      ends_at = ends_at + interval '1 microsecond'
                WHERE tenant_id = $1`,
              [tenant.tenantId],
            )
            .then(
              () => undefined,
              (failure: unknown) => failure,
            );
          expect(findPostgresError(error)).toMatchObject({
            code: PG_ERROR.checkViolation,
            constraint: `${table}_instant_precision`,
          });
        } finally {
          await client.query('ROLLBACK');
          client.release();
          await admin.end();
        }
      },
    );
  });

  describe('agendamentos', () => {
    it('chave de idempotência repetida no mesmo tenant => IdempotencyKeyConflictError', async () => {
      const idempotencyKey = randomIdempotencyKey();
      const book = (startsAt: string, endsAt: string) =>
        inTenant((tx) =>
          bookAppointment(tx, tenant, {
            staffId: tenant.staffIds[0],
            startsAt: new Date(startsAt),
            endsAt: new Date(endsAt),
            idempotencyKey,
          }),
        );
      await book('2027-03-01T13:00:00Z', '2027-03-01T14:00:00Z');
      await expect(book('2027-03-02T13:00:00Z', '2027-03-02T14:00:00Z')).rejects.toBeInstanceOf(
        IdempotencyKeyConflictError,
      );
      // Mesma chave em outro tenant não conflita (unicidade por tenant).
      await expect(
        withTenant(db, otherTenant.tenantId, (tx) =>
          bookAppointment(tx, otherTenant, {
            staffId: otherTenant.staffIds[0],
            startsAt: new Date('2027-03-01T13:00:00Z'),
            endsAt: new Date('2027-03-01T14:00:00Z'),
            idempotencyKey,
          }),
        ),
      ).resolves.toBeDefined();
    });

    it('hora repetida (fim do horário de verão): as duas ocorrências ficam distintas pelo offset', async () => {
      const newYork = first(
        await inTenant((tx) =>
          tx
            .insert(locations)
            .values({ name: 'Nova York', slug: 'nova-york', timezone: 'America/New_York' })
            .returning({ id: locations.id }),
        ),
      );
      const location = { id: newYork.id, timezone: 'America/New_York' };
      // 2026-11-01: 01:30 acontece duas vezes em Nova York (EDT -04:00, depois EST -05:00).
      const occurrences = [new Date('2026-11-01T05:30:00Z'), new Date('2026-11-01T06:30:00Z')];
      const ids: string[] = [];
      for (const startsAt of occurrences) {
        const booked = await inTenant((tx) =>
          bookAppointment(tx, tenant, {
            staffId: tenant.staffIds[0],
            startsAt,
            endsAt: new Date(startsAt.getTime() + 30 * 60_000),
            location,
          }),
        );
        ids.push(booked.appointmentId);
      }
      const rows = await inTenant((tx) =>
        tx
          .select({
            startsAt: appointments.startsAt,
            local: appointments.localStartsAt,
            offset: appointments.localUtcOffsetSeconds,
          })
          .from(appointments)
          .where(inArray(appointments.id, ids))
          .orderBy(asc(appointments.startsAt)),
      );
      expect(rows).toEqual([
        { startsAt: occurrences[0], local: '2026-11-01 01:30:00', offset: -4 * 60 * 60 },
        { startsAt: occurrences[1], local: '2026-11-01 01:30:00', offset: -5 * 60 * 60 },
      ]);
      // Hora de parede + offset reconstroem o instante sem consultar o tzdata.
      for (const row of rows) {
        const wallAsUtc = new Date(`${row.local.replace(' ', 'T')}Z`).getTime();
        expect(wallAsUtc - row.offset * 1000).toBe(row.startsAt.getTime());
      }
    });

    it('hora de parede, offset e instante precisam ser coerentes; o fuso é o da unidade', async () => {
      const request = {
        staffId: tenant.staffIds[0],
        startsAt: new Date('2027-03-04T13:00:00Z'),
        endsAt: new Date('2027-03-04T14:00:00Z'),
      };
      const attempt = (appointment: Partial<typeof appointments.$inferInsert>) =>
        captureDatabaseError(
          inTenant((tx) => bookAppointment(tx, tenant, { ...request, appointment })),
        );
      expect(await attempt({ localUtcOffsetSeconds: -4 * 60 * 60 })).toMatchObject({
        code: PG_ERROR.checkViolation,
        constraint: 'appointments_local_time_coherent',
      });
      expect(await attempt({ localStartsAt: '2027-03-04 11:00:00' })).toMatchObject({
        code: PG_ERROR.checkViolation,
        constraint: 'appointments_local_time_coherent',
      });
      expect(await attempt({ timezone: 'America/Manaus' })).toMatchObject({
        code: PG_ERROR.checkViolation,
        constraint: 'appointments_timezone_matches_location',
      });
    });

    it('pending exige validade do hold', async () => {
      expect(
        await captureSqlState(
          inTenant((tx) =>
            tx.insert(appointments).values({
              locationId: tenant.locationId,
              customerId: tenant.customerId,
              status: 'pending',
              source: 'online',
              startsAt: new Date('2027-03-03T13:00:00Z'),
              endsAt: new Date('2027-03-03T14:00:00Z'),
              localStartsAt: '2027-03-03 10:00:00',
              localUtcOffsetSeconds: -3 * 60 * 60,
              timezone: 'America/Sao_Paulo',
              idempotencyKey: randomIdempotencyKey(),
            }),
          ),
        ),
      ).toBe(PG_ERROR.checkViolation);
    });

    it('created_at é do banco também no INSERT', async () => {
      const created = first(
        await inTenant((tx) =>
          tx
            .insert(customers)
            .values({ fullName: 'Retroativo', createdAt: new Date('2000-01-01T00:00:00Z') })
            .returning({ createdAt: customers.createdAt }),
        ),
      );
      expect(created.createdAt.getUTCFullYear()).toBeGreaterThan(2000);
    });

    it('updated_at é mantido pelo banco', async () => {
      const before = first(
        await inTenant((tx) =>
          tx
            .select({ updatedAt: customers.updatedAt })
            .from(customers)
            .where(eq(customers.id, tenant.customerId)),
        ),
      );
      await inTenant((tx) =>
        tx
          .update(customers)
          .set({ fullName: 'Cliente Renomeado', updatedAt: new Date('2000-01-01T00:00:00Z') })
          .where(eq(customers.id, tenant.customerId)),
      );
      const after = first(
        await inTenant((tx) =>
          tx
            .select({ updatedAt: customers.updatedAt })
            .from(customers)
            .where(eq(customers.id, tenant.customerId)),
        ),
      );
      // O valor enviado pela aplicação é ignorado: o trigger grava o now() da transação.
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
      expect(after.updatedAt.getUTCFullYear()).toBeGreaterThan(2000);
    });
  });
});
