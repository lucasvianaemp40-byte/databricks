import { APPOINTMENT_STATUSES } from '@salon/scheduling-core';
import { describe, expect, it } from 'vitest';
import { APPOINTMENT_STATUS_LABELS, appointmentStatusLabel } from './appointment-status-labels';

describe('rótulos de status de agendamento', () => {
  it('tem um rótulo não vazio para cada status do domínio', () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(appointmentStatusLabel(status).trim(), status).not.toBe('');
    }
  });

  it('não tem rótulos para status que o domínio não conhece', () => {
    expect(Object.keys(APPOINTMENT_STATUS_LABELS).sort()).toEqual([...APPOINTMENT_STATUSES].sort());
  });

  it('usa rótulos distintos (a equipe precisa diferenciar cada situação)', () => {
    const labels = Object.values(APPOINTMENT_STATUS_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
