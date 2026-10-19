/**
 * @salon/db: schema PostgreSQL (Drizzle), acesso por tenant e erros de domínio do banco.
 *
 * Uso típico (servidor):
 *   const db = createDb(env.DATABASE_URL); // papel app_user, NUNCA o dono/superusuário
 *   await withTenant(db, session.tenantId, (tx) => tx.select().from(customers), {
 *     actor: { type: 'staff', id: session.userId },
 *   });
 *
 * O runner de migrações fica em `@salon/db/migrate` (só para CLI/CI, usa node:fs).
 * Este pacote não importa `server-only` para poder rodar em testes e scripts Node: o app
 * web deve importá-lo apenas a partir de módulos de servidor.
 */
export { type CreateDbOptions, createDb, type Database, type Schema } from './client';
export * from './errors';
export { isUuid, newId } from './ids';
export * from './schema';
export * from './schema/values';
export {
  type AuditActor,
  parseTenantId,
  type TenantTransaction,
  type WithTenantOptions,
  withTenant,
} from './tenant';
