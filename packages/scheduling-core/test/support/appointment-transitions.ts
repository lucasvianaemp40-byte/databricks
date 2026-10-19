import type { AppointmentStatus } from '../../src/appointment/appointment-status';

/**
 * Tabela de transições escrita à mão, independente de `TRANSITIONS` em src/: é o oráculo dos
 * testes de exemplo e de propriedade (propriedade que consulta a mesma tabela do código
 * não pega erro na tabela). Espelha o guard de status do banco; a paridade core x trigger
 * fica em packages/db (status-machine-sync.test.ts).
 */
export const EXPECTED_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  pending: ['confirmed', 'cancelled_by_customer', 'cancelled_by_salon', 'expired'],
  confirmed: [
    'checked_in',
    'in_service',
    'completed',
    'cancelled_by_customer',
    'cancelled_by_salon',
    'no_show',
  ],
  checked_in: ['in_service', 'completed', 'cancelled_by_customer', 'cancelled_by_salon'],
  in_service: ['completed'],
  completed: [],
  cancelled_by_customer: [],
  cancelled_by_salon: [],
  no_show: ['checked_in'],
  expired: ['confirmed'],
};
