import type { ServicePhase } from '@salon/scheduling-core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/client';
import { IdempotencyKeyConflictError, PG_ERROR } from '../../src/errors';
import { appointments, customers, locations, services, workingHours } from '../../src/schema';
import { withTenant } from '../../src/tenant';
import { captureSqlState, connectAsAppUser } from '../helpers/connections';
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
    ])('aceita %s', async (timezone) => {
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
    ])('recusa %j', async (timezone) => {
      expect(
        await captureSqlState(
          inTenant((tx) =>
            tx.insert(locations).values({ name: 'Inválida', slug: 'invalida', timezone }),
          ),
        ),
      ).toBe(PG_ERROR.checkViolation);
    });
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
    ])('recusa %s', async (_label, weekday, start, end) => {
      expect(await captureSqlState(insertHours(weekday, start, end))).toBe(PG_ERROR.checkViolation);
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
              timezone: 'America/Sao_Paulo',
              idempotencyKey: randomIdempotencyKey(),
            }),
          ),
        ),
      ).toBe(PG_ERROR.checkViolation);
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
