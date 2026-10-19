import type { ServicePhase } from '@salon/scheduling-core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema, idColumn, tenantIdColumn, timestamps } from './columns';
import { staff } from './staff';
import { tenants } from './tenants';

/**
 * Serviço do catálogo. Preço em centavos de BRL; comissão em basis points.
 *
 * `phases` usa o formato `ServicePhase` do domínio (@salon/scheduling-core): serviço
 * multi-etapa, ex.: coloração = [{kind:'work',minutes:30},{kind:'pause',minutes:40},
 * {kind:'work',minutes:30}] (na pausa o profissional fica livre). Serviço simples = uma fase
 * 'work'. O CHECK `app_private.service_phases_are_valid` exige: 1 a 8 fases, minutos
 * inteiros de 1 a 720, ao menos uma fase 'work' e soma das fases = `duration_min`.
 * Buffers (preparo/higienização) ocupam o profissional, mas não aparecem para o cliente.
 */
export const services = appSchema.table(
  'services',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    name: text('name').notNull(),
    /** Duração vista pelo cliente (soma das fases), em minutos. */
    durationMin: smallint('duration_min').notNull(),
    phases: jsonb('phases').$type<readonly ServicePhase[]>().notNull(),
    bufferBeforeMin: smallint('buffer_before_min').notNull().default(0),
    bufferAfterMin: smallint('buffer_after_min').notNull().default(0),
    priceCents: integer('price_cents').notNull(),
    /** Sobrescreve a comissão padrão do profissional (basis points). */
    commissionBps: integer('commission_bps'),
    onlineBookable: boolean('online_bookable').notNull().default(true),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('services_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({ name: 'services_tenant_fk', columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check('services_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 120`),
    check('services_duration_range', sql`${t.durationMin} BETWEEN 5 AND 720`),
    check(
      'services_phases_valid',
      sql`app_private.service_phases_are_valid(${t.phases}, ${t.durationMin})`,
    ),
    check('services_buffer_before_range', sql`${t.bufferBeforeMin} BETWEEN 0 AND 240`),
    check('services_buffer_after_range', sql`${t.bufferAfterMin} BETWEEN 0 AND 240`),
    check('services_price_range', sql`${t.priceCents} BETWEEN 0 AND 100000000`),
    check('services_commission_range', sql`${t.commissionBps} BETWEEN 0 AND 10000`),
  ],
);

/**
 * Quem faz o quê, com overrides por profissional ("corte com o dono" custa mais).
 * NULL = herda do serviço/profissional. Override de duração só faz sentido para serviço de
 * fase única (regra do domínio, validada na aplicação).
 */
export const staffServices = appSchema.table(
  'staff_services',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    staffId: uuid('staff_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    priceCents: integer('price_cents'),
    durationMin: smallint('duration_min'),
    commissionBps: integer('commission_bps'),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('staff_services_tenant_staff_service_key').on(t.tenantId, t.staffId, t.serviceId),
    index('staff_services_tenant_service_idx').on(t.tenantId, t.serviceId),
    foreignKey({
      name: 'staff_services_staff_fk',
      columns: [t.tenantId, t.staffId],
      foreignColumns: [staff.tenantId, staff.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'staff_services_service_fk',
      columns: [t.tenantId, t.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }).onDelete('cascade'),
    check('staff_services_price_range', sql`${t.priceCents} BETWEEN 0 AND 100000000`),
    check('staff_services_duration_range', sql`${t.durationMin} BETWEEN 5 AND 720`),
    check('staff_services_commission_range', sql`${t.commissionBps} BETWEEN 0 AND 10000`),
  ],
);
