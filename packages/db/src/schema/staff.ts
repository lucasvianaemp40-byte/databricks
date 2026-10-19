import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, integer, text, unique } from 'drizzle-orm/pg-core';
import {
  appSchema,
  E164_PATTERN,
  idColumn,
  matchesPattern,
  sqlStringList,
  tenantIdColumn,
  timestamps,
} from './columns';
import { tenants } from './tenants';
import { staffEngagementTypes } from './values';

/** Profissional que atende (pode ou não ter login; o vínculo com o usuário vem com a auth). */
export const staff = appSchema.table(
  'staff',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    displayName: text('display_name').notNull(),
    engagementType: text('engagement_type', { enum: staffEngagementTypes }).notNull(),
    phoneE164: text('phone_e164'),
    /** Comissão padrão do profissional em basis points (100 = 1%). */
    defaultCommissionBps: integer('default_commission_bps'),
    bookableOnline: boolean('bookable_online').notNull().default(true),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('staff_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({ name: 'staff_tenant_fk', columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check('staff_display_name_length', sql`char_length(${t.displayName}) BETWEEN 1 AND 80`),
    check(
      'staff_engagement_type_valid',
      sql`${t.engagementType} IN (${sqlStringList(staffEngagementTypes)})`,
    ),
    check('staff_phone_e164', matchesPattern(t.phoneE164, E164_PATTERN)),
    check('staff_default_commission_range', sql`${t.defaultCommissionBps} BETWEEN 0 AND 10000`),
  ],
);
