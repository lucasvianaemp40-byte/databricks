import { sql } from 'drizzle-orm';
import { check, text, unique } from 'drizzle-orm/pg-core';
import { appSchema, idColumn, matchesPattern, sqlStringList, timestamps } from './columns';
import { tenantStatuses } from './values';

/**
 * Tenant = um salão/barbearia (a organization do Better Auth, na próxima iteração).
 *
 * Raiz do isolamento: a política RLS compara `id` (não `tenant_id`) com o contexto. O `slug`
 * é público (URL da página de agendamento) e por isso é único globalmente, e não por tenant.
 * Dados fiscais/pessoais do responsável (CPF/CNPJ) ficam fora desta tabela por enquanto.
 */
export const tenants = appSchema.table(
  'tenants',
  {
    id: idColumn(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: tenantStatuses }).notNull().default('trial'),
    ...timestamps(),
  },
  (t) => [
    unique('tenants_slug_key').on(t.slug),
    check('tenants_slug_format', matchesPattern(t.slug, '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')),
    check('tenants_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 120`),
    check('tenants_status_valid', sql`${t.status} IN (${sqlStringList(tenantStatuses)})`),
  ],
);
