// biome-ignore-all assist/source/organizeImports: fixture do semgrep; cada import fica numa linha anotada.
// Fixture de `semgrep --test` para drizzle-tenant-alias. Código inseguro de propósito.
// ruleid: drizzle-tenant-alias
import { createDb, customers as c } from '@salon/db';
// ruleid: drizzle-tenant-alias
import { appointments as appts } from '@salon/db';
// ok: drizzle-tenant-alias
import { type TenantTransaction as Tx, withTenant as wt } from '@salon/db';
// ok: drizzle-tenant-alias
import { services } from '@salon/db';
// ok: drizzle-tenant-alias
import { eq as equals } from 'drizzle-orm';

declare const session: { readonly tenantId: string };

const db = createDb('postgresql://app_user@localhost/app');

export async function aliased(): Promise<unknown[]> {
  return [
    await db.select().from(c),
    await db.delete(appts).where(equals(appts.id, session.tenantId)),
    await wt(db, session.tenantId, (tx: Tx) => tx.select().from(services)),
  ];
}
