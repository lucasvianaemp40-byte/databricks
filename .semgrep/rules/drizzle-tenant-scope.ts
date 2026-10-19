// Fixture de `semgrep --test` para drizzle-tenant-scope. Código inseguro de propósito.
import { appointments, createDb, customers, type TenantTransaction, withTenant } from '@salon/db';
import { eq } from 'drizzle-orm';

declare const session: { readonly tenantId: string };
declare const customerId: string;
declare const someTable: Parameters<ReturnType<typeof createDb>['select']>[0];

const db = createDb('postgresql://app_user@localhost/app');

export async function unsafe(): Promise<unknown[]> {
  return [
    // ruleid: drizzle-tenant-scope
    await db.select().from(customers),
    // ruleid: drizzle-tenant-scope
    await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId)),
    // ruleid: drizzle-tenant-scope
    await db.update(appointments).set({ notes: null }).where(eq(appointments.id, customerId)),
    // ruleid: drizzle-tenant-scope
    await db.delete(customers).where(eq(customers.id, customerId)),
    // ruleid: drizzle-tenant-scope
    await db.query.customers.findMany(),
  ];
}

export async function safe(): Promise<unknown[]> {
  return [
    // ok: drizzle-tenant-scope
    await withTenant(db, session.tenantId, (tx) => tx.select().from(customers)),
    await withTenant(db, session.tenantId, async (tx) => {
      // ok: drizzle-tenant-scope
      return tx.delete(customers).where(eq(customers.id, customerId));
    }),
    // ok: drizzle-tenant-scope
    await withTenant(db, session.tenantId, (tx) => tx.query.appointments.findFirst(), {
      readOnly: true,
    }),
    // ok: drizzle-tenant-scope
    someTable,
  ];
}

export function listCustomers(tx: TenantTransaction) {
  // ok: drizzle-tenant-scope
  return tx.select().from(customers);
}

// ok: drizzle-tenant-scope
export const countAppointments = async (tx: TenantTransaction) => tx.$count(appointments);

// Corpo com várias instruções e callback/função tipados: o receptor é o parâmetro `tx`.
export async function safeMultiStatement(): Promise<unknown> {
  return withTenant(
    db,
    session.tenantId,
    async (tx: TenantTransaction) => {
      // ok: drizzle-tenant-scope
      const found = await tx.select().from(customers).where(eq(customers.id, customerId));
      // ok: drizzle-tenant-scope
      await tx.update(appointments).set({ notes: null }).where(eq(appointments.id, customerId));
      return found;
    },
    { readOnly: false },
  );
}

export async function removeCustomer(tx: TenantTransaction): Promise<unknown> {
  // ok: drizzle-tenant-scope
  const rows = await tx.select({ id: customers.id }).from(customers);
  // ok: drizzle-tenant-scope
  await tx.delete(customers).where(eq(customers.id, customerId));
  return rows;
}

// O receptor da query é o `db` externo, não o `tx` do callback: roda fora da transação, sem
// app.tenant_id (a RLS devolve 0 linhas ou recusa a escrita).
export async function unsafeOuterDb(): Promise<unknown[]> {
  return [
    // ruleid: drizzle-tenant-scope
    await withTenant(db, session.tenantId, async (_tx) => db.select().from(customers)),
    await withTenant(db, session.tenantId, async (tx) => {
      await tx.select().from(appointments);
      // ruleid: drizzle-tenant-scope
      return db.update(customers).set({ notes: null }).where(eq(customers.id, customerId));
    }),
  ];
}

export function outerDbInRepository(_tx: TenantTransaction) {
  // ruleid: drizzle-tenant-scope
  return db.select().from(appointments);
}

// ruleid: drizzle-tenant-scope
export const outerDbInArrow = async (_tx: TenantTransaction) => db.delete(customers);
