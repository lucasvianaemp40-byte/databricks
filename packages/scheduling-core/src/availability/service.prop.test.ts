import { fc, it } from '@fast-check/vitest';
import { Temporal } from 'temporal-polyfill';
import { describe, expect } from 'vitest';
import { serviceArb } from '../../test/arbitraries/availability';
import {
  oracleDurationMinutes,
  oracleStaffBusyMinutes,
} from '../../test/oracles/availability-oracle';
import { mergeIntervals } from '../time/intervals';
import { staffBusyIntervals, staffOccupancySegments } from './service';

const MINUTE_NS = 60_000_000_000n;

// Início com precisão de nanossegundo entre 2020 e 2035.
const startArb = fc
  .bigInt({ min: 1_577_836_800_000_000_000n, max: 2_051_222_400_000_000_000n })
  .map((ns) => Temporal.Instant.fromEpochNanoseconds(ns));

describe('ocupações gravadas na reserva (propriedades)', { tags: ['property'] }, () => {
  it.prop([startArb, serviceArb])(
    'cada buffer e cada fase de trabalho viram uma linha, na ordem, com o tipo certo (oráculo)',
    (start, service) => {
      const segments = staffOccupancySegments(start, service);
      const duration = oracleDurationMinutes(service);
      const offsets = segments.map((segment) => [
        Number((segment.start.epochNanoseconds - start.epochNanoseconds) / MINUTE_NS),
        Number((segment.end.epochNanoseconds - start.epochNanoseconds) / MINUTE_NS),
      ]);
      expect(offsets).toEqual(oracleStaffBusyMinutes(service));
      for (const segment of segments) {
        const startMinute = Number(
          (segment.start.epochNanoseconds - start.epochNanoseconds) / MINUTE_NS,
        );
        const isBuffer = startMinute < 0 || startMinute >= duration;
        expect(segment.kind).toBe(isBuffer ? 'buffer' : 'service');
        expect(Temporal.Instant.compare(segment.start, segment.end)).toBe(-1);
      }
    },
  );

  it.prop([startArb, serviceArb])(
    'as linhas não se sobrepõem e a união delas é exatamente staffBusyIntervals',
    (start, service) => {
      const segments = staffOccupancySegments(start, service);
      for (const [index, segment] of segments.entries()) {
        const next = segments[index + 1];
        if (next !== undefined) {
          expect(Temporal.Instant.compare(segment.end, next.start)).toBeLessThanOrEqual(0);
        }
      }
      const union = mergeIntervals(segments.map(({ start: s, end: e }) => ({ start: s, end: e })));
      const busy = staffBusyIntervals(start, service);
      expect(union.map((x) => [x.start.toString(), x.end.toString()])).toEqual(
        busy.map((x) => [x.start.toString(), x.end.toString()]),
      );
    },
  );
});
