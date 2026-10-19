import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, integer, smallint, text, unique } from 'drizzle-orm/pg-core';
import {
  appSchema,
  E164_PATTERN,
  idColumn,
  matchesPattern,
  tenantIdColumn,
  timestamps,
} from './columns';
import { tenants } from './tenants';
import { slotIntervalsMin } from './values';

/**
 * Unidade do salão. O fuso fica AQUI (não no tenant): uma rede pode ter loja em Manaus
 * (America/Manaus) e em São Paulo (America/Sao_Paulo). Regras de parede (jornada, feriado)
 * são interpretadas neste fuso; instantes ficam em timestamptz (UTC).
 */
export const locations = appSchema.table(
  'locations',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Nome IANA validado contra o tzdata do servidor (`app_private.is_valid_iana_timezone`). */
    timezone: text('timezone').notNull().default('America/Sao_Paulo'),
    phoneE164: text('phone_e164'),
    /** Granularidade da grade de horários oferecida online. */
    slotIntervalMin: smallint('slot_interval_min').notNull().default(15),
    /** Antecedência mínima para agendar online (minutos). */
    minNoticeMin: integer('min_notice_min').notNull().default(120),
    /** Horizonte máximo de agendamento online (dias). */
    maxAdvanceDays: integer('max_advance_days').notNull().default(60),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('locations_tenant_id_id_key').on(t.tenantId, t.id),
    unique('locations_tenant_id_slug_key').on(t.tenantId, t.slug),
    foreignKey({
      name: 'locations_tenant_fk',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }),
    check('locations_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 120`),
    check('locations_slug_format', matchesPattern(t.slug, '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')),
    check('locations_timezone_valid', sql`app_private.is_valid_iana_timezone(${t.timezone})`),
    check('locations_phone_e164', matchesPattern(t.phoneE164, E164_PATTERN)),
    check(
      'locations_slot_interval_valid',
      sql`${t.slotIntervalMin} IN (${sql.raw(slotIntervalsMin.join(', '))})`,
    ),
    check('locations_min_notice_range', sql`${t.minNoticeMin} BETWEEN 0 AND 43200`),
    check('locations_max_advance_range', sql`${t.maxAdvanceDays} BETWEEN 1 AND 365`),
  ],
);
