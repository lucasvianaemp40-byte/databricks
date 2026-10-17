import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { SchedulingInputError } from '../errors';
import { assertIanaTimeZone, localDayFrame, wallTimeToInstant } from './local-day';

const date = (iso: string) => Temporal.PlainDate.from(iso);
const utc = (instant: Temporal.Instant) => instant.toString();

describe('wallTimeToInstant', () => {
  it('deve converter hora de parede comum no fuso da unidade', () => {
    expect(utc(wallTimeToInstant(date('2026-11-03'), '09:00', 'America/Sao_Paulo'))).toBe(
      '2026-11-03T12:00:00Z',
    );
    expect(utc(wallTimeToInstant(date('2026-11-03'), '09:00', 'America/Manaus'))).toBe(
      '2026-11-03T13:00:00Z',
    );
    expect(utc(wallTimeToInstant(date('2026-11-03'), '09:00', 'America/Noronha'))).toBe(
      '2026-11-03T11:00:00Z',
    );
  });

  it('deve levar hora inexistente (lacuna de horário de verão) ao instante da transição', () => {
    // Nova York, 2026-03-08: 02:00 EST pula para 03:00 EDT. 02:30 nunca aparece no relógio;
    // o primeiro instante em que o relógio marca >= 02:30 é a própria transição (03:00 EDT).
    expect(utc(wallTimeToInstant(date('2026-03-08'), '02:30', 'America/New_York'))).toBe(
      '2026-03-08T07:00:00Z',
    );
    expect(utc(wallTimeToInstant(date('2026-03-08'), '03:00', 'America/New_York'))).toBe(
      '2026-03-08T07:00:00Z',
    );
  });

  it('deve levar a meia-noite inexistente ao início real do dia (São Paulo, 2018-11-04)', () => {
    expect(utc(wallTimeToInstant(date('2018-11-04'), '00:00', 'America/Sao_Paulo'))).toBe(
      '2018-11-04T03:00:00Z',
    );
    expect(utc(wallTimeToInstant(date('2018-11-04'), '00:59', 'America/Sao_Paulo'))).toBe(
      '2018-11-04T03:00:00Z',
    );
    expect(utc(wallTimeToInstant(date('2018-11-04'), '01:00', 'America/Sao_Paulo'))).toBe(
      '2018-11-04T03:00:00Z',
    );
  });

  it('deve escolher a primeira ocorrência de hora ambígua (fim do horário de verão)', () => {
    // Nova York, 2026-11-01: 01:30 acontece às 05:30Z (EDT) e de novo às 06:30Z (EST).
    expect(utc(wallTimeToInstant(date('2026-11-01'), '01:30', 'America/New_York'))).toBe(
      '2026-11-01T05:30:00Z',
    );
    // São Paulo, 2019-02-16: 23:30 aconteceu às 01:30Z (-02) e às 02:30Z (-03).
    expect(utc(wallTimeToInstant(date('2019-02-16'), '23:30', 'America/Sao_Paulo'))).toBe(
      '2019-02-17T01:30:00Z',
    );
  });

  it('deve tratar a lacuna de 30 minutos de Lord Howe', () => {
    // 2026-10-04: 02:00 (+10:30) pula para 02:30 (+11:00).
    expect(utc(wallTimeToInstant(date('2026-10-04'), '02:15', 'Australia/Lord_Howe'))).toBe(
      '2026-10-03T15:30:00Z',
    );
  });

  it('deve mapear 24:00 para o início do dia local seguinte', () => {
    expect(utc(wallTimeToInstant(date('2026-11-03'), '24:00', 'America/Sao_Paulo'))).toBe(
      '2026-11-04T03:00:00Z',
    );
  });

  it('deve aceitar UTC e fusos com offset fracionário', () => {
    expect(utc(wallTimeToInstant(date('2026-11-03'), '09:00', 'UTC'))).toBe('2026-11-03T09:00:00Z');
    expect(utc(wallTimeToInstant(date('2026-11-03'), '09:00', 'Asia/Kathmandu'))).toBe(
      '2026-11-03T03:15:00Z',
    );
  });

  it('deve colapsar um dia local inexistente (Pacific/Apia, 2011-12-30) num instante só', () => {
    const start = wallTimeToInstant(date('2011-12-30'), '09:00', 'Pacific/Apia');
    const end = wallTimeToInstant(date('2011-12-30'), '18:00', 'Pacific/Apia');
    expect(start).toEqual(end);
  });
});

describe('localDayFrame', () => {
  it('deve ter um único trecho de offset em dia sem transição', () => {
    const frame = localDayFrame(date('2026-11-03'), 'America/Sao_Paulo');
    expect(frame.segments).toHaveLength(1);
    expect(frame.segments[0]?.offset).toBe('-03:00');
    expect(frame.endMs - frame.startMs).toBe(24 * 3_600_000);
  });

  it('deve partir o dia na transição e medir 23 h ou 25 h', () => {
    const spring = localDayFrame(date('2026-03-08'), 'America/New_York');
    expect(spring.segments.map((s) => s.offset)).toEqual(['-05:00', '-04:00']);
    expect(spring.endMs - spring.startMs).toBe(23 * 3_600_000);

    const fall = localDayFrame(date('2026-11-01'), 'America/New_York');
    expect(fall.segments.map((s) => s.offset)).toEqual(['-04:00', '-05:00']);
    expect(fall.endMs - fall.startMs).toBe(25 * 3_600_000);
  });

  it('não deve ter trechos num dia local que não existiu', () => {
    const frame = localDayFrame(date('2011-12-30'), 'Pacific/Apia');
    expect(frame.segments).toEqual([]);
    expect(frame.endMs).toBe(frame.startMs);
  });
});

describe('assertIanaTimeZone', () => {
  it('deve aceitar identificadores IANA e UTC', () => {
    expect(() => assertIanaTimeZone('America/Sao_Paulo')).not.toThrow();
    expect(() => assertIanaTimeZone('UTC')).not.toThrow();
  });

  it.each(['-03:00', '+00:00', 'Brasil/Brasilia', 'UTC-3', ''])('deve rejeitar %j', (timeZone) => {
    expect(() => assertIanaTimeZone(timeZone)).toThrow(SchedulingInputError);
  });

  it('deve rejeitar calendário que não é ISO 8601', () => {
    const gregorian = Temporal.PlainDate.from({ year: 2026, month: 11, day: 3 }).withCalendar(
      'gregory',
    );
    expect(() => wallTimeToInstant(gregorian, '09:00', 'UTC')).toThrow(SchedulingInputError);
  });
});
