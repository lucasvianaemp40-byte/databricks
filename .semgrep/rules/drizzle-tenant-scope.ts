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
