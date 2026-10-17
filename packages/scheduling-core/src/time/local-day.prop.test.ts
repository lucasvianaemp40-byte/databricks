import { fc, it } from '@fast-check/vitest';
import { Temporal } from 'temporal-polyfill';
import { describe, expect } from 'vitest';
import { zoneAndDateArb } from '../../test/arbitraries/time';
import { oracleWallToInstant } from '../../test/oracles/availability-oracle';
import { localDayFrame, wallMinuteToEpochMs, wallTimeToInstant } from './local-day';

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
});
