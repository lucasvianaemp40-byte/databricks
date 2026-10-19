import { APPOINTMENT_STATUSES, type ServicePhase } from '@salon/scheduling-core';
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
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  appSchema,
  idColumn,
  instant,
  instantHasMillisecondPrecision,
  matchesPattern,
  sqlStringList,
  tenantIdColumn,
  timestamps,
  tstzrange,
} from './columns';
import { customers } from './customers';
import { locations } from './locations';
import { services } from './services';
import { staff } from './staff';
import {
  appointmentEventTypes,
  appointmentSources,
  auditActorTypes,
  occupancyKinds,
} from './values';

/**
 * Agendamento = uma VISITA do cliente (um ou mais itens de serviço/profissional).
 *
 * Status: a lista e a máquina de estados vêm do domínio (`@salon/scheduling-core`). O banco
 * repete as duas como defesa em profundidade: CHECK da coluna e trigger
 * `appointments_guard_status` (migração 0003), que também preenche os instantes de cada
 * transição e só permite nascer como `pending`/`confirmed`. Testes amarram banco e core.
 * `version` é incrementada pelo banco a cada UPDATE (lock otimista:
 * `UPDATE ... WHERE id = $1 AND version = $2`).
 *
 * `local_starts_at` + `local_utc_offset_seconds` + `timezone` guardam a hora de parede
 * escolhida, o offset UTC daquela ocorrência e o fuso IANA da unidade no momento da reserva.
 * O offset distingue as duas ocorrências da hora repetida no fim do horário de verão (01:30
 * -04:00 e 01:30 -05:00). CHECK `appointments_local_time_coherent`: hora de parede = instante
 * + offset (truncada ao segundo), aritmética pura, sem depender do tzdata. O fuso precisa ser o
 * da unidade (trigger `appointments_guard_location_timezone`, migração 0003).
 * Se a regra do fuso mudar (volta do horário de verão), o recálculo planejado de `starts_at`
 * (caminho privilegiado: a aplicação não altera o horário de uma visita) usa Temporal (`ZonedDateTime.from('<local><offset>[<fuso>]', { offset: 'prefer' })`) e uma
 * política explícita para offset que deixou de valer; nunca `AT TIME ZONE` no SQL.
 *
 * Instantes de transição (`confirmed_at` ... `expired_at`) e `hold_expires_at` são do banco:
 * o trigger `appointments_guard_status` ignora o valor enviado, grava `now()` na transição e
 * só deixa o hold mudar enquanto o agendamento está `pending`.
 *
 * `idempotency_key` (header Idempotency-Key da criação) é única por tenant: repetir o
 * comando devolve 23505 em `appointments_tenant_idempotency_key_key`.
 *
 * Unidade, fuso, horário (instantes, hora de parede e offset) são imutáveis depois da criação:
 * remarcar é criar outro agendamento (`rescheduled_from_id`). No COMMIT, os itens precisam
 * caber na janela da visita.
 */
export const appointments = appSchema.table(
  'appointments',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    locationId: uuid('location_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    status: text('status', { enum: APPOINTMENT_STATUSES }).notNull(),
    source: text('source', { enum: appointmentSources }).notNull(),
    startsAt: instant('starts_at').notNull(),
    endsAt: instant('ends_at').notNull(),
    /** Hora de parede escolhida ('YYYY-MM-DD HH:MM:SS', sem fuso). */
    localStartsAt: timestamp('local_starts_at', { mode: 'string' }).notNull(),
    /** Offset UTC da hora de parede, em segundos (São Paulo: -10800). */
    localUtcOffsetSeconds: integer('local_utc_offset_seconds').notNull(),
    /** Fuso IANA da unidade no momento da reserva. */
    timezone: text('timezone').notNull(),
    /** Validade do hold de um agendamento `pending` (obrigatória nesse status). */
    holdExpiresAt: instant('hold_expires_at'),
    confirmedAt: instant('confirmed_at'),
    checkedInAt: instant('checked_in_at'),
    startedAt: instant('started_at'),
    completedAt: instant('completed_at'),
    cancelledAt: instant('cancelled_at'),
    noShowAt: instant('no_show_at'),
    expiredAt: instant('expired_at'),
    cancellationReason: text('cancellation_reason'),
    idempotencyKey: text('idempotency_key').notNull(),
    rescheduledFromId: uuid('rescheduled_from_id'),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique('appointments_tenant_id_id_key').on(t.tenantId, t.id),
    unique('appointments_tenant_idempotency_key_key').on(t.tenantId, t.idempotencyKey),
    index('appointments_tenant_location_starts_idx').on(t.tenantId, t.locationId, t.startsAt),
    index('appointments_tenant_customer_starts_idx').on(t.tenantId, t.customerId, t.startsAt),
    index('appointments_tenant_pending_hold_idx')
      .on(t.tenantId, t.holdExpiresAt)
      .where(sql`${t.status} = 'pending'`),
    foreignKey({
      name: 'appointments_location_fk',
      columns: [t.tenantId, t.locationId],
      foreignColumns: [locations.tenantId, locations.id],
    }),
    foreignKey({
      name: 'appointments_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'appointments_rescheduled_from_fk',
      columns: [t.tenantId, t.rescheduledFromId],
      foreignColumns: [t.tenantId, t.id],
    }),
    check(
      'appointments_status_valid',
      sql`${t.status} IN (${sqlStringList(APPOINTMENT_STATUSES)})`,
    ),
    check('appointments_source_valid', sql`${t.source} IN (${sqlStringList(appointmentSources)})`),
    check('appointments_time_order', sql`${t.endsAt} > ${t.startsAt}`),
    check('appointments_max_length', sql`${t.endsAt} - ${t.startsAt} <= interval '24 hours'`),
    check('appointments_instant_precision', instantHasMillisecondPrecision(t.startsAt, t.endsAt)),
    check('appointments_timezone_valid', sql`app_private.is_valid_iana_timezone(${t.timezone})`),
    check(
      'appointments_utc_offset_range',
      sql`${t.localUtcOffsetSeconds} BETWEEN -64800 AND 64800`,
    ),
    check(
      'appointments_local_time_coherent',
      sql`${t.localStartsAt} = date_trunc('second', (${t.startsAt} AT TIME ZONE 'UTC') + make_interval(secs => ${t.localUtcOffsetSeconds}))`,
    ),
    check(
      'appointments_pending_requires_hold',
      sql`${t.status} <> 'pending' OR ${t.holdExpiresAt} IS NOT NULL`,
    ),
    check(
      'appointments_idempotency_key_format',
      matchesPattern(t.idempotencyKey, '^[A-Za-z0-9._:-]{8,128}$'),
    ),
    check(
      'appointments_cancellation_reason_length',
      sql`char_length(${t.cancellationReason}) BETWEEN 1 AND 500`,
    ),
    check('appointments_version_positive', sql`${t.version} >= 1`),
    check('appointments_not_rescheduled_from_self', sql`${t.rescheduledFromId} <> ${t.id}`),
  ],
);

/**
 * Item da visita: serviço x profissional, com SNAPSHOT de nome, duração, fases, buffers, preço
 * e comissão (relatórios, comissões e a agenda não mudam quando o catálogo muda).
 *
 * `starts_at`/`ends_at` são a janela VISÍVEL do serviço (soma das fases = `duration_min`,
 * CHECK `appointment_items_duration_coherent`); os buffers congelados ampliam a janela em que
 * o profissional pode estar ocupado. No COMMIT, as ocupações `service` ativas do item precisam
 * cobrir cada fase `work` (constraint trigger `appointment_items_occupancy_required`).
 * Visita, profissional, horário, duração, fases e buffers do item são imutáveis, e um item com
 * ocupação ativa não é apagado (trigger `appointment_items_guard_schedule`, migração 0003):
 * remarcar é criar outro agendamento.
 */
export const appointmentItems = appSchema.table(
  'appointment_items',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    appointmentId: uuid('appointment_id').notNull(),
    position: smallint('position').notNull(),
    serviceId: uuid('service_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    serviceName: text('service_name').notNull(),
    durationMin: smallint('duration_min').notNull(),
    /** Fases congeladas (`ServicePhase` do core): as `work` precisam estar ocupadas. */
    phases: jsonb('phases').$type<readonly ServicePhase[]>().notNull(),
    priceCents: integer('price_cents').notNull(),
    commissionBps: integer('commission_bps').notNull(),
    /** Preparo antes do atendimento (minutos), congelado do serviço na reserva. */
    bufferBeforeMin: smallint('buffer_before_min').notNull().default(0),
    /** Limpeza depois do atendimento (minutos), congelado do serviço na reserva. */
    bufferAfterMin: smallint('buffer_after_min').notNull().default(0),
    startsAt: instant('starts_at').notNull(),
    endsAt: instant('ends_at').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('appointment_items_tenant_id_id_key').on(t.tenantId, t.id),
    // Alvo da FK das ocupações: a ocupação aponta para um item DA MESMA visita e do MESMO
    // profissional (staff_id da ocupação = staff_id do item).
    unique('appointment_items_tenant_appointment_id_staff_key').on(
      t.tenantId,
      t.appointmentId,
      t.id,
      t.staffId,
    ),
    unique('appointment_items_tenant_appointment_position_key').on(
      t.tenantId,
      t.appointmentId,
      t.position,
    ),
    index('appointment_items_tenant_staff_starts_idx').on(t.tenantId, t.staffId, t.startsAt),
    index('appointment_items_tenant_service_idx').on(t.tenantId, t.serviceId),
    foreignKey({
      name: 'appointment_items_appointment_fk',
      columns: [t.tenantId, t.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'appointment_items_service_fk',
      columns: [t.tenantId, t.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }),
    foreignKey({
      name: 'appointment_items_staff_fk',
      columns: [t.tenantId, t.staffId],
      foreignColumns: [staff.tenantId, staff.id],
    }),
    check('appointment_items_position_range', sql`${t.position} BETWEEN 1 AND 50`),
    check(
      'appointment_items_service_name_length',
      sql`char_length(${t.serviceName}) BETWEEN 1 AND 120`,
    ),
    check('appointment_items_duration_range', sql`${t.durationMin} BETWEEN 5 AND 720`),
    check(
      'appointment_items_phases_valid',
      sql`app_private.service_phases_are_valid(${t.phases}, ${t.durationMin})`,
    ),
    check(
      'appointment_items_duration_coherent',
      sql`${t.endsAt} - ${t.startsAt} = make_interval(mins => ${t.durationMin})`,
    ),
    check('appointment_items_price_range', sql`${t.priceCents} BETWEEN 0 AND 100000000`),
    check('appointment_items_commission_range', sql`${t.commissionBps} BETWEEN 0 AND 10000`),
    check('appointment_items_time_order', sql`${t.endsAt} > ${t.startsAt}`),
    check(
      'appointment_items_instant_precision',
      instantHasMillisecondPrecision(t.startsAt, t.endsAt),
    ),
    check('appointment_items_buffer_before_range', sql`${t.bufferBeforeMin} BETWEEN 0 AND 240`),
    check('appointment_items_buffer_after_range', sql`${t.bufferAfterMin} BETWEEN 0 AND 240`),
  ],
);

/**
 * Intervalo em que um profissional está ocupado por um item (uma linha por trecho ocupado:
 * `service` contém fase de trabalho, `buffer` é só preparo/limpeza). A garantia
 * anti-overbooking é do BANCO: EXCLUDE `occupancies_no_staff_overlap` (tenant_id =,
 * staff_id =, during &&) WHERE active (migração 0003). Dois commits concorrentes no mesmo
 * horário: um recebe 23P01 (`SlotUnavailableError`).
 *
 * Para o EXCLUDE valer, a ocupação não pode ser escondida nem desalinhada:
 * - `active` é DERIVADA do status do agendamento (trigger `occupancies_derive_active`): o
 *   valor enviado é ignorado (cancelar, no-show e expirar liberam; reativar re-checa o EXCLUDE);
 * - FK composta com o item inclui `staff_id`: a ocupação é do profissional do item;
 * - trigger `occupancies_guard_within_item`: o trecho cabe na janela do item ampliada pelos
 *   buffers congelados, e `service` toca a janela visível;
 * - a aplicação só faz INSERT e UPDATE de `active` (sem DELETE nem UPDATE de outras colunas);
 * - constraint trigger adiada `appointments_occupancy_required`: no COMMIT, todo item de
 *   agendamento que ocupa a agenda tem ao menos uma ocupação `service` ativa.
 */
export const occupancies = appSchema.table(
  'occupancies',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    appointmentId: uuid('appointment_id').notNull(),
    appointmentItemId: uuid('appointment_item_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    kind: text('kind', { enum: occupancyKinds }).notNull().default('service'),
    startsAt: instant('starts_at').notNull(),
    endsAt: instant('ends_at').notNull(),
    during: tstzrange('during')
      .notNull()
      .generatedAlwaysAs(sql`tstzrange("starts_at", "ends_at", '[)')`),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    index('occupancies_tenant_appointment_item_idx').on(
      t.tenantId,
      t.appointmentId,
      t.appointmentItemId,
    ),
    foreignKey({
      name: 'occupancies_appointment_item_fk',
      columns: [t.tenantId, t.appointmentId, t.appointmentItemId, t.staffId],
      foreignColumns: [
        appointmentItems.tenantId,
        appointmentItems.appointmentId,
        appointmentItems.id,
        appointmentItems.staffId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'occupancies_staff_fk',
      columns: [t.tenantId, t.staffId],
      foreignColumns: [staff.tenantId, staff.id],
    }),
    check('occupancies_kind_valid', sql`${t.kind} IN (${sqlStringList(occupancyKinds)})`),
    check('occupancies_time_order', sql`${t.endsAt} > ${t.startsAt}`),
    check('occupancies_max_length', sql`${t.endsAt} - ${t.startsAt} <= interval '24 hours'`),
    check('occupancies_instant_precision', instantHasMillisecondPrecision(t.startsAt, t.endsAt)),
  ],
);

/**
 * Trilha de auditoria APPEND-ONLY das transições do agendamento. Escrita SOMENTE pelo
 * trigger `appointments_write_event` (SECURITY DEFINER): os papéis da aplicação têm apenas
 * SELECT, então não conseguem forjar, alterar nem apagar eventos. Um trigger rejeita UPDATE,
 * DELETE e TRUNCATE até para o dono da tabela.
 *
 * Exceção deliberada à convenção `created_at`/`updated_at`: linha imutável não tem
 * `updated_at`. O id é v4 (`gen_random_uuid()`, gerado no banco pelo trigger); a ordem
 * cronológica vem de `created_at` (`clock_timestamp()`).
 */
export const appointmentEvents = appSchema.table(
  'appointment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    appointmentId: uuid('appointment_id').notNull(),
    eventType: text('event_type', { enum: appointmentEventTypes }).notNull(),
    fromStatus: text('from_status', { enum: APPOINTMENT_STATUSES }),
    toStatus: text('to_status', { enum: APPOINTMENT_STATUSES }).notNull(),
    actorType: text('actor_type', { enum: auditActorTypes }).notNull(),
    actorId: text('actor_id'),
    createdAt: instant('created_at').notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    index('appointment_events_tenant_appointment_idx').on(t.tenantId, t.appointmentId, t.createdAt),
    // Sem ON DELETE CASCADE: um agendamento com histórico não pode ser apagado.
    foreignKey({
      name: 'appointment_events_appointment_fk',
      columns: [t.tenantId, t.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }),
    check(
      'appointment_events_type_valid',
      sql`${t.eventType} IN (${sqlStringList(appointmentEventTypes)})`,
    ),
    check(
      'appointment_events_from_status_valid',
      sql`${t.fromStatus} IN (${sqlStringList(APPOINTMENT_STATUSES)})`,
    ),
    check(
      'appointment_events_to_status_valid',
      sql`${t.toStatus} IN (${sqlStringList(APPOINTMENT_STATUSES)})`,
    ),
    check(
      'appointment_events_from_status_shape',
      sql`(${t.eventType} = 'created') = (${t.fromStatus} IS NULL)`,
    ),
    check(
      'appointment_events_actor_type_valid',
      sql`${t.actorType} IN (${sqlStringList(auditActorTypes)})`,
    ),
    check('appointment_events_actor_id_length', sql`char_length(${t.actorId}) BETWEEN 1 AND 128`),
  ],
);
