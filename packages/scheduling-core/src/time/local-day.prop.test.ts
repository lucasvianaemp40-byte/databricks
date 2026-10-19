import { fc, it } from '@fast-check/vitest';
import { Temporal } from 'temporal-polyfill';
import { describe, expect } from 'vitest';
import { backwardPastMidnightZoneAndDateArb, zoneAndDateArb } from '../../test/arbitraries/time';
import { oracleWallToInstant } from '../../test/oracles/availability-oracle';
import { SchedulingInputError } from '../errors';
import {
  assertIanaTimeZone,
  localDayFrame,
  wallMinuteToEpochMs,
  wallTimeToInstant,
} from './local-day';

const minuteArb = fc.integer({ min: 0, max: 1440 });
const hhmm = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

describe('hora de parede e dia local (propriedades)', { tags: ['property'] }, () => {
  it.prop([zoneAndDateArb(), minuteArb])(
    'wallTimeToInstant deve seguir a regra documentada (oráculo direto em Temporal)',
    ({ timeZone, from }, minute) => {
      expect(wallTimeToInstant(from, hhmm(minute), timeZone)).toEqual(
        oracleWallToInstant(from, minute, timeZone),
      );
    },
  );

  it.prop([zoneAndDateArb(), minuteArb, minuteArb])(
    'a conversão deve ser monotônica: turno com início < fim nunca vira intervalo invertido',
    ({ timeZone, from }, a, b) => {
      const frame = localDayFrame(from, timeZone);
      const [low, high] = a <= b ? [a, b] : [b, a];
      expect(wallMinuteToEpochMs(frame, low)).toBeLessThanOrEqual(wallMinuteToEpochMs(frame, high));
    },
  );

  it.prop([zoneAndDateArb(), fc.integer({ min: 0, max: 1439 })])(
    'hora que existe deve voltar ao mesmo rótulo no fuso (ida e volta)',
    ({ timeZone, from }, minute) => {
      const instant = wallTimeToInstant(from, hhmm(minute), timeZone);
      const zoned = instant.toZonedDateTimeISO(timeZone);
      const wall = from.toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 });
      const exists = wall
        .toZonedDateTime(timeZone, { disambiguation: 'earlier' })
        .toPlainDateTime()
        .equals(wall);
      if (exists) expect(zoned.toPlainDateTime().equals(wall)).toBe(true);
      else expect(Temporal.PlainDateTime.compare(zoned.toPlainDateTime(), wall)).toBe(1);
    },
  );

  it.prop([zoneAndDateArb()])(
    'o quadro do dia deve cobrir o dia local com trechos contíguos e offsets do Temporal',
    ({ timeZone, from }) => {
      const frame = localDayFrame(from, timeZone);
      expect(frame.startMs).toBe(from.toZonedDateTime({ timeZone }).epochMilliseconds);
      expect(frame.endMs).toBe(
        from.add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds,
      );
      let cursor = frame.startMs;
      for (const segment of frame.segments) {
        expect(segment.startMs).toBe(cursor);
        expect(segment.endMs).toBeGreaterThan(segment.startMs);
        for (const probe of [segment.startMs, segment.endMs - 1]) {
          const zoned = Temporal.Instant.fromEpochMilliseconds(probe).toZonedDateTimeISO(timeZone);
          expect(zoned.offset).toBe(segment.offset);
          expect(zoned.offsetNanoseconds).toBe(segment.offsetMs * 1_000_000);
          expect(zoned.toPlainDate().equals(from)).toBe(true);
        }
        cursor = segment.endMs;
      }
      expect(cursor).toBe(frame.endMs);
    },
  );

  it.prop([backwardPastMidnightZoneAndDateArb(), minuteArb, minuteArb])(
    'relógio que volta para a véspera: quadro contíguo, offsets do Temporal e conversão monotônica',
    ({ timeZone, from }, a, b) => {
      // Nesses dias o quadro contém instantes que marcam D-1 (ver LocalDayFrame): aqui se
      // verifica só o que ele garante.
      const frame = localDayFrame(from, timeZone);
      expect(frame.startMs).toBe(from.toZonedDateTime({ timeZone }).epochMilliseconds);
      expect(frame.endMs).toBe(
        from.add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds,
      );
      let cursor = frame.startMs;
      for (const segment of frame.segments) {
        expect(segment.startMs).toBe(cursor);
        expect(segment.endMs).toBeGreaterThan(segment.startMs);
        for (const probe of [segment.startMs, segment.endMs - 1]) {
          const zoned = Temporal.Instant.fromEpochMilliseconds(probe).toZonedDateTimeISO(timeZone);
          expect(zoned.offset).toBe(segment.offset);
          expect(zoned.offsetNanoseconds).toBe(segment.offsetMs * 1_000_000);
        }
        cursor = segment.endMs;
      }
      expect(cursor).toBe(frame.endMs);
      const [low, high] = a <= b ? [a, b] : [b, a];
      expect(wallMinuteToEpochMs(frame, low)).toBeLessThanOrEqual(wallMinuteToEpochMs(frame, high));
      expect(wallTimeToInstant(from, hhmm(low), timeZone)).toEqual(
        oracleWallToInstant(from, low, timeZone),
      );
    },
  );
});

/**
 * Oráculo independente do código: o formato do CHECK do banco em
 * app_private.is_valid_iana_timezone (packages/db/drizzle/0001_private_functions.sql),
 * '^[A-Za-z]+(/[A-Za-z_+-]+)+$', reescrito sem quantificador aninhado (mesma linguagem,
 * conferida por força bruta em todas as cadeias de até 7 caracteres de um alfabeto com
 * letra, '_', '+', '-', '/', dígito, espaço e quebra de linha).
 */
const DB_TIMEZONE_SHAPE = /^(?!.*\/\/)(?!.*\/$)[A-Za-z]+\/[A-Za-z_+/-]+$/;
const DB_TIMEZONE_MAX_LENGTH = 64;

const CANONICAL_ZONES = Intl.supportedValuesOf('timeZone');

/** Nomes que o tzdata do runtime conhece mas o banco recusa (sem "/" ou com dígito), e vizinhos. */
const TRICKY_ZONES = [
  'UTC',
  'GMT',
  'Zulu',
  'UCT',
  'Etc/UTC',
  'Etc/GMT',
  'Etc/GMT0',
  'EST5EDT',
  'SystemV/AST4',
  'US/Eastern',
  'Brazil/East',
] as const;

/** Etc/GMT±N: existem no tzdata, mas são offset fixo (proibido de propósito). */
const etcGmtOffsetArb = fc
  .tuple(fc.constantFrom('+', '-', ''), fc.integer({ min: 0, max: 14 }))
  .map(([sign, hours]) => `Etc/GMT${sign}${String(hours)}`);

/** Nome real com um trecho inserido numa posição qualquer (dígito, sinal, barra, espaço...). */
const mutatedZoneArb = fc
  .tuple(
    fc.constantFrom(...CANONICAL_ZONES, ...TRICKY_ZONES),
    fc.nat(),
    fc.constantFrom('3', '+3', '-03', '0', '/', '//', ' ', '\n', ';', '_', '-', '+'),
  )
  .map(([name, at, piece]) => {
    const index = at % (name.length + 1);
    return name.slice(0, index) + piece + name.slice(index);
  });

const timeZoneNameArb = fc.oneof(
  fc.constantFrom(...TRICKY_ZONES),
  etcGmtOffsetArb,
  fc.constantFrom(...CANONICAL_ZONES),
  // O tzdata ignora maiúsculas e minúsculas (no Temporal e no PostgreSQL).
  fc.constantFrom(...CANONICAL_ZONES).map((name) => name.toLowerCase()),
  mutatedZoneArb,
  fc.stringMatching(/^[A-Za-z0-9/_+ -]{0,24}$/),
);

const acceptsTimeZone = (timeZone: string): boolean => {
  try {
    assertIanaTimeZone(timeZone);
    return true;
  } catch (error) {
    if (error instanceof SchedulingInputError) return false;
    throw error;
  }
};

describe('validação do fuso (propriedades)', { tags: ['property'] }, () => {
  it.prop([timeZoneNameArb])(
    'todo fuso aceito pelo core tem o formato que o banco aceita (core ⊆ formato do banco)',
    (timeZone) => {
      if (!acceptsTimeZone(timeZone)) return;
      expect(timeZone).toMatch(DB_TIMEZONE_SHAPE);
      expect(timeZone.length).toBeLessThanOrEqual(DB_TIMEZONE_MAX_LENGTH);
    },
  );
});
