import { fc, it } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  allowedTransitions,
  canTransition,
  INITIAL_APPOINTMENT_STATUSES,
  isTerminalStatus,
  occupiesSchedule,
  transitionAppointmentStatus,
} from './appointment-status';

const statusArb = fc.constantFrom(...APPOINTMENT_STATUSES);
// Inclui lixo vindo de dado externo (texto do banco, versão antiga da API).
const anyTargetArb = fc.oneof(
  { weight: 9, arbitrary: statusArb },
  {
    weight: 1,
    arbitrary: fc.string().map((s) => s as AppointmentStatus),
  },
);

describe('máquina de estados do agendamento (propriedades)', { tags: ['property'] }, () => {
  it.prop([
    fc.constantFrom(...INITIAL_APPOINTMENT_STATUSES),
    fc.array(anyTargetArb, { maxLength: 30 }),
  ])(
    'num passeio aleatório, só transições da tabela mudam o status; terminal é absorvente',
    (initial, attempts) => {
      let status: AppointmentStatus = initial;
      for (const target of attempts) {
        const result = transitionAppointmentStatus(status, target);
        expect(result.ok).toBe(canTransition(status, target));
        if (result.ok) {
          expect(result).toEqual({ ok: true, from: status, to: target });
          status = result.to;
        } else if (isTerminalStatus(status)) {
          expect(['terminal_status', 'unchanged', 'unknown_status']).toContain(result.error.code);
        }
      }
    },
  );

  it.prop([statusArb, statusArb])(
    'o código de erro deve classificar exatamente o motivo da recusa',
    (from, to) => {
      const result = transitionAppointmentStatus(from, to);
      if (result.ok) {
        expect(allowedTransitions(from)).toContain(to);
        return;
      }
      const expected =
        from === to
          ? 'unchanged'
          : isTerminalStatus(from)
            ? 'terminal_status'
            : 'transition_not_allowed';
      expect(result.error.code).toBe(expected);
      expect(result.error.from).toBe(from);
      expect(result.error.to).toBe(to);
    },
  );

  it.prop([statusArb])(
    'de todo status deve existir caminho até um status terminal (sem beco sem saída)',
    (start) => {
      const seen = new Set<AppointmentStatus>([start]);
      const queue: AppointmentStatus[] = [start];
      for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
        for (const next of allowedTransitions(current)) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect([...seen].some((status) => isTerminalStatus(status))).toBe(true);
    },
  );

  it.prop([statusArb])(
    'status terminal não sai; quem libera a agenda não volta a ocupá-la sem passar pela tabela',
    (status) => {
      if (isTerminalStatus(status)) expect(allowedTransitions(status)).toEqual([]);
      if (!occupiesSchedule(status)) {
        // Só os reativáveis (no_show -> checked_in, expired -> confirmed) saem desse grupo,
        // e o banco re-checa o EXCLUDE ao reativar.
        for (const next of allowedTransitions(status)) {
          expect(['checked_in', 'confirmed']).toContain(next);
        }
      }
    },
  );
});
