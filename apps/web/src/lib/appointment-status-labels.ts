/**
 * Rótulos em pt-BR dos status de agendamento definidos no domínio (@salon/scheduling-core).
 *
 * O `satisfies Record<AppointmentStatus, string>` torna o mapa exaustivo: quando o domínio
 * ganhar um status novo, o typecheck do app falha até alguém escrever o rótulo.
 */
import type { AppointmentStatus } from '@salon/scheduling-core';

export const APPOINTMENT_STATUS_LABELS = Object.freeze({
  pending: 'Aguardando confirmação',
  confirmed: 'Confirmado',
  checked_in: 'Cliente chegou',
  in_service: 'Em atendimento',
  completed: 'Concluído',
  cancelled_by_customer: 'Cancelado pelo cliente',
  cancelled_by_salon: 'Cancelado pelo salão',
  no_show: 'Não compareceu',
  expired: 'Expirado',
} as const satisfies Record<AppointmentStatus, string>);

export function appointmentStatusLabel(status: AppointmentStatus): string {
  return APPOINTMENT_STATUS_LABELS[status];
}
