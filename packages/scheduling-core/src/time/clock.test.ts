import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { SchedulingInputError } from '../errors';
import { fixedClock, systemClock } from './clock';

describe('fixedClock', () => {
  it('deve devolver sempre o mesmo instante, a partir de ISO 8601 com offset', () => {
    const clock = fixedClock('2026-11-03T09:00:00-03:00');
    expect(clock.now()).toEqual(Temporal.Instant.from('2026-11-03T12:00:00Z'));
    expect(clock.now()).toEqual(clock.now());
  });

  it('deve aceitar um Temporal.Instant', () => {
    const instant = Temporal.Instant.fromEpochMilliseconds(1_800_000_000_000);
    expect(fixedClock(instant).now()).toEqual(instant);
  });

  it('deve rejeitar data/hora sem offset (dependeria do fuso da máquina)', () => {
    expect(() => fixedClock('2026-11-03T09:00:00')).toThrow(SchedulingInputError);
    expect(() => fixedClock('ontem')).toThrow(/clock/);
  });
});

describe('systemClock', () => {
  it('deve devolver instantes do relógio real, sem regredir entre leituras consecutivas', () => {
    const first = systemClock.now();
    const second = systemClock.now();
    expect(first).toBeInstanceOf(Temporal.Instant);
    expect(Temporal.Instant.compare(second, first)).toBeGreaterThanOrEqual(0);
    // Sanidade: depois de 2026-01-01 (pega relógio zerado ou unidade errada).
    expect(first.epochMilliseconds).toBeGreaterThan(1_767_225_600_000);
  });
});
