import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/client';
import { IdentifierConflictError, PG_ERROR, TenantIsolationError } from '../../src/errors';
import { appointmentItems, appointments, customers, occupancies, tenants } from '../../src/schema';
import { type TenantTransaction, withTenant } from '../../src/tenant';
import {
  captureSqlState,
  connectAsAdmin,
  connectAsAppUser,
  connectAsWorker,
  listTenantTables,
} from '../helpers/connections';
import { createTenantFixture, randomIdempotencyKey, type TenantFixture } from '../helpers/fixtures';

const app = sql.identifier('app');

describe('isolamento multi-tenant (RLS) com o papel app_user', () => {
  let db: Database;
  let worker: Database;
  let admin: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tenantTables: string[];

  /** Linhas de B em cada tabela, vistas pelo superusuário (sem RLS). */
  async function countRowsOf(tenantId: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const table of tenantTables) {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.${pg.escapeIdentifier(table)} WHERE tenant_id = $1`,
        [tenantId],
      );
      counts.set(table, rows[0]?.n ?? 0);
    }
    return counts;
  }

  beforeAll(async () => {
    db = connectAsAppUser();
    worker = connectAsWorker();
    admin = connectAsAdmin();
    tenantTables = await listTenantTables(admin);
    tenantA = await createTenantFixture(db);
    tenantB = await createTenantFixture(db);
  });

  afterAll(async () => {
    await Promise.all([db.$client.end(), worker.$client.end(), admin.end()]);
  });

  it('deve cobrir todas as tabelas de tenant do schema', () => {
    expect(tenantTables).toEqual([
      'appointment_events',
      'appointment_items',
      'appointments',
      'customers',
      'locations',
      'occupancies',
      'services',
      'staff',
      'staff_services',
      'time_off',
      'working_hours',
    ]);
  });

  it('o fixture deve deixar linhas dos dois tenants em toda tabela (senão o teste não prova nada)', async () => {
    const rowsOfA = await countRowsOf(tenantA.tenantId);
    const rowsOfB = await countRowsOf(tenantB.tenantId);
    for (const table of tenantTables) {
      expect(rowsOfA.get(table), table).toBeGreaterThan(0);
      expect(rowsOfB.get(table), table).toBeGreaterThan(0);
    }
  });

  it('tenant A não lê nenhuma linha de B em nenhuma tabela', async () => {
    const leaked = await withTenant(db, tenantA.tenantId, async (tx) => {
      const result: Record<string, number> = {};
      for (const table of tenantTables) {
        const { rows } = await tx.execute<{ foreign: number; own: number }>(
          sql`SELECT count(*) FILTER (WHERE tenant_id <> ${tenantA.tenantId})::int AS foreign,
                     count(*) FILTER (WHERE tenant_id = ${tenantA.tenantId})::int AS own
                FROM ${app}.${sql.identifier(table)}`,
        );
        result[table] = rows[0]?.foreign ?? -1;
        expect(rows[0]?.own, `${table}: A deve ver as próprias linhas`).toBeGreaterThan(0);
      }
      return result;
    });
    expect(Object.values(leaked).every((count) => count === 0)).toBe(true);
  });

  it('tenant A não lê o registro de B em app.tenants', async () => {
    const visible = await withTenant(db, tenantA.tenantId, (tx) =>
      tx.select({ id: tenants.id }).from(tenants),
    );
    expect(visible).toEqual([{ id: tenantA.tenantId }]);
  });

  it('tenant A não atualiza nem apaga linhas de B (0 linhas ou privilégio negado)', async () => {
    const before = await countRowsOf(tenantB.tenantId);
    for (const table of tenantTables) {
      const { rows } = await admin.query<{ can_update: boolean; can_delete: boolean }>(
        `SELECT has_table_privilege('app_user', $1, 'UPDATE') AS can_update,
                has_table_privilege('app_user', $1, 'DELETE') AS can_delete`,
        [`app.${table}`],
      );
      const privileges = rows[0];

      const update = withTenant(db, tenantA.tenantId, (tx) =>
        tx.execute(
          sql`UPDATE ${app}.${sql.identifier(table)} SET tenant_id = tenant_id
               WHERE tenant_id = ${tenantB.tenantId}`,
        ),
      );
      if (privileges?.can_update === true) {
        expect((await update).rowCount, `${table}: UPDATE`).toBe(0);
      } else {
        await expect(update, `${table}: UPDATE sem privilégio`).rejects.toBeInstanceOf(
          TenantIsolationError,
        );
      }

      const remove = withTenant(db, tenantA.tenantId, (tx) =>
        tx.execute(
          sql`DELETE FROM ${app}.${sql.identifier(table)} WHERE tenant_id = ${tenantB.tenantId}`,
        ),
      );
      if (privileges?.can_delete === true) {
        expect((await remove).rowCount, `${table}: DELETE`).toBe(0);
      } else {
        await expect(remove, `${table}: DELETE sem privilégio`).rejects.toBeInstanceOf(
          TenantIsolationError,
        );
      }
    }
    expect(await countRowsOf(tenantB.tenantId)).toEqual(before);
  });

  it('deve negar INSERT com tenant_id de outro tenant (42501 -> TenantIsolationError)', async () => {
    await expect(
      withTenant(db, tenantA.tenantId, (tx) =>
        tx.insert(customers).values({ tenantId: tenantB.tenantId, fullName: 'Intruso' }),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      withTenant(db, tenantA.tenantId, (tx) =>
        tx.insert(tenants).values({ id: tenantB.tenantId, slug: 'outro-salao', name: 'Outro' }),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('deve negar UPDATE que move uma linha própria para outro tenant', async () => {
    await expect(
      withTenant(db, tenantA.tenantId, (tx) =>
        tx
          .update(customers)
          .set({ tenantId: tenantB.tenantId })
          .where(eq(customers.id, tenantA.customerId)),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      withTenant(db, tenantA.tenantId, (tx) =>
        tx.execute(sql`UPDATE app.occupancies SET tenant_id = ${tenantB.tenantId}`),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('sem contexto de tenant: 0 linhas em toda tabela, sem erro (falha fechada)', async () => {
    for (const table of [...tenantTables, 'tenants']) {
      const { rows } = await db.$client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.${pg.escapeIdentifier(table)}`,
      );
      expect(rows[0]?.n, table).toBe(0);
    }
  });

  it('sem contexto de tenant: INSERT é negado (tenant_id NULL ou fora da política)', async () => {
    // Sem tenant_id: o default vem do contexto vazio => NULL. O PostgreSQL avalia o WITH CHECK
    // da RLS antes do NOT NULL, então a recusa chega como 42501 (as duas seriam falha fechada).
    expect(
      await captureSqlState(
        db.$client.query("INSERT INTO app.customers (full_name) VALUES ('Sem contexto')"),
      ),
    ).toBe(PG_ERROR.insufficientPrivilege);
    // Com tenant_id explícito: a política RESTRICTIVE recusa.
    expect(
      await captureSqlState(
        db.$client.query('INSERT INTO app.customers (tenant_id, full_name) VALUES ($1, $2)', [
          tenantA.tenantId,
          'Sem contexto',
        ]),
      ),
    ).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('FK composta torna impossível referenciar linha de outro tenant, mesmo sabendo o UUID', async () => {
    const [staffOfA] = tenantA.staffIds;
    // Agendamento de B apontando para o cliente de A.
    expect(
      await captureSqlState(
        withTenant(db, tenantB.tenantId, (tx) =>
          tx.insert(appointments).values({
            locationId: tenantB.locationId,
            customerId: tenantA.customerId,
            status: 'confirmed',
            source: 'staff',
            startsAt: new Date('2026-12-02T12:00:00Z'),
            endsAt: new Date('2026-12-02T13:00:00Z'),
            localStartsAt: '2026-12-02 09:00:00',
            localUtcOffsetSeconds: -3 * 60 * 60,
            timezone: 'America/Sao_Paulo',
            idempotencyKey: randomIdempotencyKey(),
          }),
        ),
      ),
    ).toBe(PG_ERROR.foreignKeyViolation);
    // Item de B com serviço e profissional de A.
    expect(
      await captureSqlState(
        withTenant(db, tenantB.tenantId, (tx) =>
          tx.insert(appointmentItems).values({
            appointmentId: tenantB.appointmentId,
            position: 2,
            serviceId: tenantA.serviceId,
            staffId: staffOfA,
            serviceName: 'Corte',
            durationMin: 60,
            phases: [{ kind: 'work', minutes: 60 }],
            priceCents: 1,
            commissionBps: 0,
            startsAt: new Date('2026-12-02T12:00:00Z'),
            endsAt: new Date('2026-12-02T13:00:00Z'),
          }),
        ),
      ),
    ).toBe(PG_ERROR.foreignKeyViolation);
    // Ocupação de B bloqueando a agenda do profissional de A.
    const itemOfB = await withTenant(db, tenantB.tenantId, (tx) =>
      tx
        .select({ id: appointmentItems.id })
        .from(appointmentItems)
        .where(eq(appointmentItems.appointmentId, tenantB.appointmentId)),
    );
    expect(
      await captureSqlState(
        withTenant(db, tenantB.tenantId, (tx) =>
          tx.insert(occupancies).values({
            appointmentId: tenantB.appointmentId,
            appointmentItemId: itemOfB[0]?.id ?? '',
            staffId: staffOfA,
            startsAt: new Date('2026-12-03T12:00:00Z'),
            endsAt: new Date('2026-12-03T13:00:00Z'),
          }),
        ),
      ),
    ).toBe(PG_ERROR.foreignKeyViolation);
  });

  it('app_worker também é isolado e só tem os privilégios dos jobs', async () => {
    const seen = await withTenant(worker, tenantA.tenantId, (tx) =>
      tx.select({ tenantId: customers.tenantId }).from(customers),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((row) => row.tenantId === tenantA.tenantId)).toBe(true);

    await expect(
      withTenant(worker, tenantA.tenantId, (tx) =>
        tx.insert(customers).values({ fullName: 'Worker não cria cliente' }),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      withTenant(worker, tenantA.tenantId, (tx) =>
        tx.delete(customers).where(eq(customers.id, tenantA.customerId)),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('app_worker só altera o status do agendamento: não move horário, cliente nem ocupação', async () => {
    const attempts = [
      (tx: TenantTransaction) =>
        tx
          .update(appointments)
          .set({ startsAt: new Date('2026-12-01T15:00:00Z') })
          .where(eq(appointments.id, tenantA.appointmentId)),
      (tx: TenantTransaction) =>
        tx
          .update(appointments)
          .set({ customerId: tenantA.customerId, idempotencyKey: randomIdempotencyKey() })
          .where(eq(appointments.id, tenantA.appointmentId)),
      (tx: TenantTransaction) =>
        tx
          .update(occupancies)
          .set({ staffId: tenantA.staffIds[1] })
          .where(eq(occupancies.appointmentId, tenantA.appointmentId)),
    ];
    for (const attempt of attempts) {
      await expect(withTenant(worker, tenantA.tenantId, attempt)).rejects.toBeInstanceOf(
        TenantIsolationError,
      );
    }
  });

  it('PK global: INSERT com o id de outro tenant é recusado sem confirmar existência nem tocar a linha', async () => {
    const before = await countRowsOf(tenantB.tenantId);
    const { rows: original } = await admin.query<{ full_name: string }>(
      'SELECT full_name FROM app.customers WHERE id = $1',
      [tenantB.customerId],
    );
    await expect(
      withTenant(db, tenantA.tenantId, (tx) =>
        tx.insert(customers).values({ id: tenantB.customerId, fullName: 'Sonda' }),
      ),
    ).rejects.toBeInstanceOf(IdentifierConflictError);
    expect(await countRowsOf(tenantB.tenantId)).toEqual(before);
    const { rows: after } = await admin.query<{ full_name: string }>(
      'SELECT full_name FROM app.customers WHERE id = $1',
      [tenantB.customerId],
    );
    expect(after).toEqual(original);
  });
});
