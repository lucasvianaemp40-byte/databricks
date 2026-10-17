import { describe, expect, it } from 'vitest';
import {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  AppointmentTransitionError,
  allowedTransitions,
  canTransition,
  INITIAL_APPOINTMENT_STATUSES,
  isAppointmentStatus,
  isTerminalStatus,
  occupiesSchedule,
  transitionAppointmentStatus,
} from './appointment-status';

// Tabela explícita (documentação viva). Espelha o guard de status do banco.
const EXPECTED: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
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

const ALL_PAIRS = APPOINTMENT_STATUSES.flatMap((from) =>
  APPOINTMENT_STATUSES.map((to) => [from, to] as const),
);

describe('máquina de estados do agendamento', () => {
  it('deve conhecer exatamente os 9 status do domínio', () => {
    expect([...APPOINTMENT_STATUSES].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(INITIAL_APPOINTMENT_STATUSES).toEqual(['pending', 'confirmed']);
  });

  it.each(ALL_PAIRS)('%s -> %s deve seguir a tabela de transições', (from, to) => {
    const expected = EXPECTED[from].includes(to);
    expect(canTransition(from, to)).toBe(expected);
    const result = transitionAppointmentStatus(from, to);
    expect(result.ok).toBe(expected);
  });

  it('deve listar as transições permitidas de cada status', () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect([...allowedTransitions(status)].sort()).toEqual([...EXPECTED[status]].sort());
    }
  });

  it('deve devolver o novo status quando a transição é válida', () => {
    expect(transitionAppointmentStatus('pending', 'confirmed')).toEqual({
      ok: true,
      from: 'pending',
      to: 'confirmed',
    });
  });

  it('deve rejeitar transição proibida com erro tipado', () => {
    const result = transitionAppointmentStatus('in_service', 'cancelled_by_customer');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AppointmentTransitionError);
    expect(result.error).toMatchObject({
      name: 'AppointmentTransitionError',
      code: 'transition_not_allowed',
      from: 'in_service',
      to: 'cancelled_by_customer',
    });
    expect(result.error.message).toContain('in_service -> cancelled_by_customer');
  });

  it('deve rejeitar sair de status terminal com código próprio', () => {
    for (const terminal of ['completed', 'cancelled_by_customer', 'cancelled_by_salon'] as const) {
      const result = transitionAppointmentStatus(terminal, 'confirmed');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('terminal_status');
    }
  });

  it('deve sinalizar "sem mudança" para o mesmo status (o chamador decide se é idempotente)', () => {
    const result = transitionAppointmentStatus('confirmed', 'confirmed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unchanged');
  });

  it('deve rejeitar status desconhecido vindo de dado externo', () => {
    const result = transitionAppointmentStatus('cancelled' as AppointmentStatus, 'confirmed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_status');
    expect(canTransition('pending', 'archived' as AppointmentStatus)).toBe(false);
    expect(allowedTransitions('archived' as AppointmentStatus)).toEqual([]);
    expect(isTerminalStatus('archived' as AppointmentStatus)).toBe(false);
    expect(occupiesSchedule('archived' as AppointmentStatus)).toBe(false);
    expect(transitionAppointmentStatus('pending', 'archived' as AppointmentStatus).ok).toBe(false);
  });

  it('deve permitir lançar o erro do resultado (é um Error de verdade)', () => {
    const result = transitionAppointmentStatus('completed', 'pending');
    expect(() => {
      if (!result.ok) throw result.error;
    }).toThrow(AppointmentTransitionError);
  });

  it('deve identificar status terminais', () => {
    expect(APPOINTMENT_STATUSES.filter((s) => isTerminalStatus(s))).toEqual([
      'completed',
      'cancelled_by_customer',
      'cancelled_by_salon',
    ]);
  });

  it('deve dizer quais status mantêm o horário ocupado na agenda', () => {
    expect(APPOINTMENT_STATUSES.filter((s) => occupiesSchedule(s))).toEqual([
      'pending',
      'confirmed',
      'checked_in',
      'in_service',
      'completed',
    ]);
  });

  it('deve validar texto vindo do banco ou da API', () => {
    expect(isAppointmentStatus('no_show')).toBe(true);
    expect(isAppointmentStatus('cancelled_client')).toBe(false);
    expect(isAppointmentStatus('toString')).toBe(false);
    expect(isAppointmentStatus(undefined)).toBe(false);
    expect(isAppointmentStatus(3)).toBe(false);
  });
});
