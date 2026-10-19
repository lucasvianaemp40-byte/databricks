import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, smallint, text, time, uuid } from 'drizzle-orm/pg-core';
import {
  appSchema,
  idColumn,
  instant,
  instantHasMillisecondPrecision,
  sqlStringList,
  tenantIdColumn,
  timestamps,
  tstzrange,
} from './columns';
import { locations } from './locations';
import { staff } from './staff';
import { timeOffKinds } from './values';

/**
 * Jornada semanal em HORA DE PAREDE no fuso da unidade, com vigência. O motor de
 * disponibilidade converte para instantes dia a dia (DST e mudanças de tzdata ficam corretas).
 * Almoço = duas faixas no mesmo dia. `weekday` segue a ISO 8601: 1 = segunda ... 7 = domingo.
 * O banco devolve 'HH:MM:SS': o adaptador para `WorkShift` do core converte de forma estrita
 * ('09:00:00' -> '09:00', '24:00:00' -> '24:00') e recusa qualquer outro formato.
 *
 * Constraint EXCLUDE `working_hours_no_overlap` (migração 0003): o mesmo profissional não tem
 * faixas sobrepostas no mesmo dia da semana e vigência, nem em unidades diferentes (não está
 * em dois lugares ao mesmo tempo). Compara hora de parede: unidades com fusos diferentes
 * exigem checagem adicional na aplicação. Turno que vira a meia-noite está fora do MVP.
 */
export const workingHours = appSchema.table(
  'working_hours',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    staffId: uuid('staff_id').notNull(),
    locationId: uuid('location_id').notNull(),
    weekday: smallint('weekday').notNull(),
    /** Hora local de início ('HH:MM:SS', minuto cheio; o core usa 'HH:MM'). */
    startTime: time('start_time').notNull(),
    /** Hora local de término, exclusiva ('HH:MM:SS', minuto cheio; '24:00:00' = fim do dia). */
    endTime: time('end_time').notNull(),
    /** Data local ('YYYY-MM-DD') de início da vigência, inclusiva. */
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    /** Data local de fim da vigência, inclusiva; NULL = sem fim. */
    validUntil: date('valid_until', { mode: 'string' }),
    ...timestamps(),
  },
  (t) => [
    index('working_hours_tenant_location_idx').on(t.tenantId, t.locationId),
    foreignKey({
      name: 'working_hours_staff_fk',
      columns: [t.tenantId, t.staffId],
      foreignColumns: [staff.tenantId, staff.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'working_hours_location_fk',
      columns: [t.tenantId, t.locationId],
      foreignColumns: [locations.tenantId, locations.id],
    }).onDelete('cascade'),
    check('working_hours_weekday_range', sql`${t.weekday} BETWEEN 1 AND 7`),
    check('working_hours_time_order', sql`${t.endTime} > ${t.startTime}`),
    // O core representa hora de parede como 'HH:MM': segundos ou frações não têm tradução.
    check(
      'working_hours_whole_minutes',
      sql`extract(second FROM ${t.startTime}) = 0 AND extract(second FROM ${t.endTime}) = 0`,
    ),
    check(
      'working_hours_validity_order',
      sql`${t.validUntil} IS NULL OR ${t.validUntil} >= ${t.validFrom}`,
    ),
  ],
);

/**
 * Bloqueio pontual da agenda de um profissional, em instantes absolutos: folga, férias,
 * curso, bloqueio. `during` é gerada (`[starts_at, ends_at)`) para o índice GiST.
 * `note` é texto curto operacional: nunca registre motivo de saúde (LGPD art. 11).
 */
export const timeOff = appSchema.table(
  'time_off',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    staffId: uuid('staff_id').notNull(),
    kind: text('kind', { enum: timeOffKinds }).notNull(),
    startsAt: instant('starts_at').notNull(),
    endsAt: instant('ends_at').notNull(),
    during: tstzrange('during')
      .notNull()
      .generatedAlwaysAs(sql`tstzrange("starts_at", "ends_at", '[)')`),
    note: text('note'),
    ...timestamps(),
  },
  (t) => [
    index('time_off_tenant_staff_during_idx').using('gist', t.tenantId, t.staffId, t.during),
    foreignKey({
      name: 'time_off_staff_fk',
      columns: [t.tenantId, t.staffId],
      foreignColumns: [staff.tenantId, staff.id],
    }).onDelete('cascade'),
    check('time_off_kind_valid', sql`${t.kind} IN (${sqlStringList(timeOffKinds)})`),
    check('time_off_order', sql`${t.endsAt} > ${t.startsAt}`),
    check('time_off_instant_precision', instantHasMillisecondPrecision(t.startsAt, t.endsAt)),
    check('time_off_max_length', sql`${t.endsAt} - ${t.startsAt} <= interval '400 days'`),
    check('time_off_note_length', sql`char_length(${t.note}) BETWEEN 1 AND 200`),
  ],
);
