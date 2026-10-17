import { fc, it } from '@fast-check/vitest';
import { Temporal } from 'temporal-polyfill';
import { describe, expect } from 'vitest';
import {
  availabilityInputArb,
  extraBusyArb,
  serviceWithPauseArb,
} from '../../test/arbitraries/availability';
import { fixedOffsetZoneAndDateArb } from '../../test/arbitraries/time';
import {
  type NsRange,
  oracleDurationMinutes,
  oracleSlots,
  oracleStaffBusyAt,
  oracleStaffBusyMinutes,
  oracleWindows,
  rangesOverlap,
} from '../../test/oracles/availability-oracle';
import { fixedClock } from '../time/clock';
import type { Interval } from '../time/intervals';
import {
  type AvailabilityInput,
  type AvailableSlot,
  computeAvailableSlots,
} from './compute-available-slots';

const NS_PER_MINUTE = 60_000_000_000n;
const NS_PER_MS = 1_000_000n;

const inputArb = availabilityInputArb();

const nowNs = (input: AvailabilityInput): bigint => input.clock.now().epochNanoseconds;
const asRange = (x: Interval): NsRange => ({
  start: x.start.epochNanoseconds,
  end: x.end.epochNanoseconds,
});
const unavailableOf = (input: AvailabilityInput): NsRange[] =>
  [...input.busy, ...input.timeOff].map(asRange);
const key = (slot: AvailableSlot): string =>
  `${slot.start.toString()} ${slot.localDate} ${slot.localTime}${slot.utcOffset}`;
const plain = (slots: readonly AvailableSlot[]) =>
  slots.map((slot) => ({
    startNs: slot.start.epochNanoseconds,
    endNs: slot.end.epochNanoseconds,
    localDate: slot.localDate,
    localTime: slot.localTime,
    utcOffset: slot.utcOffset,
  }));
const dayStartNs = (input: AvailabilityInput): bigint =>
  input.from.toZonedDateTime({ timeZone: input.timeZone }).epochNanoseconds;

describe('computeAvailableSlots (propriedades)', { tags: ['property'] }, () => {
  it.prop([inputArb])(
    'P1: todo horário deve caber inteiro na jornada do seu dia local',
    (input) => {
      for (const slot of computeAvailableSlots(input)) {
        const windows = oracleWindows(input, Temporal.PlainDate.from(slot.localDate));
        const { start, end } = asRange(slot);
        expect(windows.some((w) => w.start <= start && end <= w.end)).toBe(true);
      }
    },
  );

  it.prop([inputArb])(
    'P2: nenhum horário deve tocar ocupação ou bloqueio, considerando fases e buffers',
    (input) => {
      const unavailable = unavailableOf(input);
      for (const slot of computeAvailableSlots(input)) {
        for (const piece of oracleStaffBusyAt(slot.start.epochNanoseconds, input.service)) {
          expect(unavailable.some((u) => rangesOverlap(piece, u))).toBe(false);
        }
      }
    },
  );

  it.prop([inputArb])(
    'P3: horários devem vir em ordem estrita, sem repetição e com a duração exata do serviço',
    (input) => {
      const slots = computeAvailableSlots(input);
      const durationNs = BigInt(oracleDurationMinutes(input.service)) * NS_PER_MINUTE;
      for (const [index, slot] of slots.entries()) {
        expect(slot.end.epochNanoseconds - slot.start.epochNanoseconds).toBe(durationNs);
        const previous = slots[index - 1];
        if (previous !== undefined) {
          expect(Temporal.Instant.compare(previous.start, slot.start)).toBe(-1);
        }
      }
    },
  );

  it.prop([inputArb])(
    'P4: todo início deve respeitar antecedência mínima e horizonte máximo do Clock',
    (input) => {
      const now = nowNs(input);
      for (const slot of computeAvailableSlots(input)) {
        const start = slot.start.epochNanoseconds;
        expect(start >= now + BigInt(input.minNoticeMinutes) * NS_PER_MINUTE).toBe(true);
        expect(start <= now + BigInt(input.maxAdvanceMinutes) * NS_PER_MINUTE).toBe(true);
      }
    },
  );

  it.prop([inputArb, fc.array(fc.nat(), { minLength: 1, maxLength: 8 })])(
    'P5: reservar em sequência horários oferecidos nunca deve sobrepor dois atendimentos',
    (input, picks) => {
      let state = input;
      const bookings: NsRange[][] = [];
      for (const pick of picks) {
        const available = computeAvailableSlots(state);
        const chosen = available[pick % Math.max(available.length, 1)];
        if (chosen === undefined) break;
        const pieces = oracleStaffBusyAt(chosen.start.epochNanoseconds, input.service);
        bookings.push(pieces);
        const asIntervals = pieces.map((p) => ({
          start: Temporal.Instant.fromEpochNanoseconds(p.start),
          end: Temporal.Instant.fromEpochNanoseconds(p.end),
        }));
        state = { ...state, busy: [...state.busy, ...asIntervals] };
      }
      for (const [i, a] of bookings.entries()) {
        for (const b of bookings.slice(i + 1)) {
          expect(a.some((x) => b.some((y) => rangesOverlap(x, y)))).toBe(false);
        }
      }
    },
  );

  it.prop([inputArb, extraBusyArb])(
    'P6: uma nova ocupação nunca deve criar horário novo (monotonicidade)',
    (input, extra) => {
      const start = Temporal.Instant.fromEpochNanoseconds(
        dayStartNs(input) + BigInt(extra.offsetMinutes) * NS_PER_MINUTE,
      );
      const busy = [...input.busy, { start, end: start.add({ minutes: extra.lengthMinutes }) }];
      const before = new Set(computeAvailableSlots(input).map(key));
      for (const slot of computeAvailableSlots({ ...input, busy })) {
        expect(before.has(key(slot))).toBe(true);
      }
    },
  );

  it.prop([inputArb])(
    'P7: oráculo minuto a minuto: cada minuto do atendimento na jornada e cada minuto ocupado livre',
    (input) => {
      const unavailable = unavailableOf(input);
      const staffBusy = oracleStaffBusyMinutes(input.service);
      const duration = oracleDurationMinutes(input.service);
      for (const slot of computeAvailableSlots(input)) {
        const startNs = slot.start.epochNanoseconds;
        const windows = oracleWindows(input, Temporal.PlainDate.from(slot.localDate));
        for (let minute = 0; minute < duration; minute += 1) {
          const m = startNs + BigInt(minute) * NS_PER_MINUTE;
          expect(windows.some((w) => w.start <= m && m < w.end)).toBe(true);
        }
        for (const [from, to] of staffBusy) {
          for (let minute = from; minute < to; minute += 1) {
            const m = startNs + BigInt(minute) * NS_PER_MINUTE;
            expect(unavailable.some((u) => u.start <= m && m < u.end)).toBe(false);
          }
        }
      }
    },
  );

  it.prop([inputArb])(
    'P8: rótulo local, data e offset devem bater com o Temporal, com ida e volta exata',
    (input) => {
      for (const slot of computeAvailableSlots(input)) {
        const zoned = slot.start.toZonedDateTimeISO(input.timeZone);
        expect(slot.localDate).toBe(zoned.toPlainDate().toString());
        expect(slot.localTime).toBe(zoned.toPlainTime().toString({ smallestUnit: 'minute' }));
        expect(slot.utcOffset).toBe(zoned.offset);
        const roundTrip = Temporal.ZonedDateTime.from(
          `${slot.localDate}T${slot.localTime}${slot.utcOffset}[${input.timeZone}]`,
        );
        expect(roundTrip.epochNanoseconds).toBe(slot.start.epochNanoseconds);
        const date = Temporal.PlainDate.from(slot.localDate);
        expect(Temporal.PlainDate.compare(input.from, date)).toBeLessThanOrEqual(0);
        expect(Temporal.PlainDate.compare(date, input.to)).toBeLessThanOrEqual(0);
      }
    },
  );

  it.prop([inputArb])(
    'P9: deve coincidir com o oráculo de força bruta (todo horário livre aparece, nenhum a mais)',
    (input) => {
      expect(plain(computeAvailableSlots(input))).toEqual(oracleSlots(input));
    },
  );

  it.prop([inputArb])(
    'P10: todo início deve cair na grade do relógio local (múltiplo da granularidade desde 00:00)',
    (input) => {
      for (const slot of computeAvailableSlots(input)) {
        const zoned = slot.start.toZonedDateTimeISO(input.timeZone);
        const minuteOfDay = zoned.hour * 60 + zoned.minute;
        expect(minuteOfDay % input.granularityMinutes).toBe(0);
        expect(slot.start.epochNanoseconds % NS_PER_MS).toBe(0n);
        expect([zoned.second, zoned.millisecond, zoned.microsecond, zoned.nanosecond]).toEqual([
          0, 0, 0, 0,
        ]);
      }
    },
  );

  it.prop([inputArb])('P11: deve ser determinístico e não alterar a entrada', (input) => {
    // JSON.stringify serializa Instant/PlainDate via toJSON (ISO), suficiente para o retrato.
    const snapshot = JSON.stringify(input);
    const first = computeAvailableSlots(input);
    const second = computeAvailableSlots(input);
    expect(second.map(key)).toEqual(first.map(key));
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it.prop([availabilityInputArb({ service: serviceWithPauseArb })])(
    'P12: ocupação que cabe na pausa do serviço não deve tirar o horário (profissional livre)',
    (input) => {
      const [firstWork, pause] = input.service.phases;
      if (firstWork === undefined || pause === undefined) throw new Error('arbitrário inválido');
      for (const slot of computeAvailableSlots(input).slice(0, 4)) {
        const pauseStart = slot.start.add({ minutes: firstWork.minutes });
        const busy = [
          ...input.busy,
          { start: pauseStart, end: pauseStart.add({ minutes: pause.minutes }) },
        ];
        expect(computeAvailableSlots({ ...input, busy }).map(key)).toContain(key(slot));
      }
    },
  );

  it.prop([availabilityInputArb({ zoneAndDate: fixedOffsetZoneAndDateArb })])(
    'P13: fuso de offset fixo deve equivaler a UTC transladado (rótulos idênticos)',
    (input) => {
      const offsetNs = BigInt(
        input.from.toZonedDateTime({ timeZone: input.timeZone }).offsetNanoseconds,
      );
      const shift = (x: Temporal.Instant): Temporal.Instant =>
        Temporal.Instant.fromEpochNanoseconds(x.epochNanoseconds + offsetNs);
      const shiftAll = (xs: readonly Interval[]): Interval[] =>
        xs.map((x) => ({ start: shift(x.start), end: shift(x.end) }));
      const inUtc = computeAvailableSlots({
        ...input,
        timeZone: 'UTC',
        busy: shiftAll(input.busy),
        timeOff: shiftAll(input.timeOff),
        clock: fixedClock(shift(input.clock.now())),
      });
      const local = computeAvailableSlots(input);
      expect(inUtc.map((s) => `${s.localDate} ${s.localTime}`)).toEqual(
        local.map((s) => `${s.localDate} ${s.localTime}`),
      );
      expect(inUtc.map((s) => s.start.epochNanoseconds - offsetNs)).toEqual(
        local.map((s) => s.start.epochNanoseconds),
      );
    },
  );

  it.prop([inputArb, fc.constantFrom(0, 15, 60, 1440), fc.constantFrom(0, 60, 1440)])(
    'P14: mais antecedência nunca cria horário; mais horizonte nunca remove horário',
    (input, extraNotice, extraHorizon) => {
      const all = new Set(computeAvailableSlots(input).map(key));
      const stricter = computeAvailableSlots({
        ...input,
        minNoticeMinutes: input.minNoticeMinutes + extraNotice,
      });
      for (const slot of stricter) expect(all.has(key(slot))).toBe(true);
      const wider = new Set(
        computeAvailableSlots({
          ...input,
          maxAdvanceMinutes: input.maxAdvanceMinutes + extraHorizon,
        }).map(key),
      );
      for (const slotKey of all) expect(wider.has(slotKey)).toBe(true);
    },
  );

  it.prop([inputArb])(
    'P15: ordem das listas e origem (ocupação ou bloqueio) não devem mudar o resultado',
    (input) => {
      const expected = computeAvailableSlots(input).map(key);
      const reshuffled = computeAvailableSlots({
        ...input,
        busy: [...input.timeOff].reverse(),
        timeOff: [...input.busy].reverse(),
        weeklySchedule: [...input.weeklySchedule].reverse(),
      });
      expect(reshuffled.map(key)).toEqual(expected);
    },
  );
});
