import { describe, expect, it } from 'vitest';
import * as core from './index';

describe('API pública de @salon/scheduling-core', () => {
  it('deve exportar exatamente as funções, constantes e classes documentadas', () => {
    expect(Object.keys(core).sort()).toEqual(
      [
        'APPOINTMENT_STATUSES',
        'AppointmentTransitionError',
        'INITIAL_APPOINTMENT_STATUSES',
        'MAX_RANGE_DAYS',
        // biome-ignore lint/security/noSecrets: nome de export público, não é segredo.
        'SchedulingInputError',
        'allowedTransitions',
        'assertIanaTimeZone',
        'canTransition',
        'compareIntervals',
        'computeAvailableSlots',
        'containsInterval',
        'fixedClock',
        'formatWallTime',
        'interval',
        'intersectIntervals',
        'isAppointmentStatus',
        'isEmptyInterval',
        'isTerminalStatus',
        'mergeIntervals',
        'occupiesSchedule',
        'overlaps',
        'parseWallTime',
        'serviceFootprint',
        'singlePhaseService',
        'sortIntervals',
        'staffBusyIntervals',
        'subtractIntervals',
        'systemClock',
        'transitionAppointmentStatus',
        'wallTimeToInstant',
      ].sort(),
    );
  });

  it('não deve deixar constantes públicas mutáveis em tempo de execução', () => {
    expect(Object.isFrozen(core.APPOINTMENT_STATUSES)).toBe(true);
    expect(Object.isFrozen(core.INITIAL_APPOINTMENT_STATUSES)).toBe(true);
    expect(Object.isFrozen(core.allowedTransitions('pending'))).toBe(true);
    expect(Object.isFrozen(core.systemClock)).toBe(true);
    expect(Object.isFrozen(core.fixedClock('2026-11-03T12:00:00Z'))).toBe(true);
  });
});
