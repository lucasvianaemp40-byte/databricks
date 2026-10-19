import { describe, expect, it } from 'vitest';
import { SchedulingInputError } from '../errors';
import { formatWallTime, parseWallTime } from './wall-time';

describe('parseWallTime', () => {
  it('deve converter HH:MM em minutos desde a meia-noite local', () => {
    expect(parseWallTime('00:00')).toBe(0);
    expect(parseWallTime('09:30')).toBe(570);
    expect(parseWallTime('23:59')).toBe(1439);
  });

  it('deve aceitar 24:00 só quando permitido (fim de turno = fim do dia local)', () => {
    expect(parseWallTime('24:00', { allowEndOfDay: true })).toBe(1440);
    expect(() => parseWallTime('24:00')).toThrow(SchedulingInputError);
  });

  it.each(['9:00', '09:0', '24:01', '25:00', '12:60', '12:30:00', ' 12:30', '12h30', ''])(
    'deve rejeitar o formato inválido %j',
    (value) => {
      expect(() => parseWallTime(value, { allowEndOfDay: true })).toThrow(SchedulingInputError);
    },
  );

  it('deve citar o campo no erro', () => {
    expect(() => parseWallTime('xx', { field: 'weeklySchedule[0].start' })).toThrow(
      /weeklySchedule\[0\]\.start/,
    );
  });
});

describe('formatWallTime', () => {
  it('deve formatar minutos como HH:MM com zero à esquerda', () => {
    expect(formatWallTime(0)).toBe('00:00');
    expect(formatWallTime(545)).toBe('09:05');
    expect(formatWallTime(1439)).toBe('23:59');
    expect(formatWallTime(1440)).toBe('24:00');
  });

  it('deve rejeitar valores fora de 0..1440 ou não inteiros', () => {
    expect(() => formatWallTime(-1)).toThrow(RangeError);
    expect(() => formatWallTime(1441)).toThrow(RangeError);
    expect(() => formatWallTime(1.5)).toThrow(RangeError);
  });
});
