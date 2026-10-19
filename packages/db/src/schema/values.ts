/**
 * Valores enumerados do schema. Cada lista alimenta, ao mesmo tempo, o tipo TypeScript da
 * coluna e o CHECK do banco (via `sqlStringList`), então os dois não divergem.
 */

export const tenantStatuses = ['trial', 'active', 'suspended', 'closed'] as const;
export type TenantStatus = (typeof tenantStatuses)[number];

/**
 * Vínculo do profissional com o salão. Define comissão x cota-parte (Lei 12.592/2012,
 * art. 1º-A, incluído pela Lei 13.352/2016 do salão-parceiro):
 * - owner: dono que também atende;
 * - employee: empregado CLT;
 * - partner: profissional-parceiro (contrato de parceria, cota-parte);
 * - freelancer: autônomo sem contrato de parceria.
 */
export const staffEngagementTypes = ['owner', 'employee', 'partner', 'freelancer'] as const;
export type StaffEngagementType = (typeof staffEngagementTypes)[number];

/** Granularidades de grade de horários oferecidas na agenda online (minutos). */
export const slotIntervalsMin = [5, 10, 15, 20, 30, 60] as const;

/** Motivo do bloqueio de agenda. Nunca registre motivo de saúde (dado sensível, LGPD art. 11). */
export const timeOffKinds = ['time_off', 'vacation', 'training', 'blocked'] as const;
export type TimeOffKind = (typeof timeOffKinds)[number];

export const appointmentSources = ['online', 'staff', 'walk_in'] as const;
export type AppointmentSource = (typeof appointmentSources)[number];

/** `service`: o atendimento em si; `buffer`: preparo/higienização (não aparece para o cliente). */
export const occupancyKinds = ['service', 'buffer'] as const;
export type OccupancyKind = (typeof occupancyKinds)[number];

export const appointmentEventTypes = ['created', 'status_changed'] as const;
export type AppointmentEventType = (typeof appointmentEventTypes)[number];

/**
 * Quem causou o evento de auditoria (GUC `app.actor_type`, definido por `withTenant`).
 * `unknown` torna visível uma transação que não declarou o ator, em vez de mascará-la.
 */
export const auditActorTypes = ['customer', 'staff', 'system', 'unknown'] as const;
export type AuditActorType = (typeof auditActorTypes)[number];
