import * as fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import type {
  AvailabilityInput,
  IsoWeekday,
  WorkShift,
} from '../../src/availability/compute-available-slots';
import type { ServiceDefinition, ServicePhaseKind } from '../../src/availability/service';
import { fixedClock } from '../../src/time/clock';
import type { Interval } from '../../src/time/intervals';
import { subMinuteNoiseNsArb, type ZoneAndDate, zoneAndDateArb } from './time';

const NS_PER_MINUTE = 60_000_000_000n;

const pad = (n: number): string => String(n).padStart(2, '0');
/** Formatador próprio dos testes (não usa o de src/). */
export const hhmm = (minuteOfDay: number): string =>
  `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`;

export const serviceArb: fc.Arbitrary<ServiceDefinition> = fc
  .record({
    phases: fc.array(
      fc.record({
        kind: fc.constantFrom<ServicePhaseKind>('work', 'work', 'pause'),
        minutes: fc.constantFrom(5, 10, 15, 20, 25, 30, 40, 45, 60, 90),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    bufferBeforeMinutes: fc.constantFrom(0, 0, 5, 10, 15),
    bufferAfterMinutes: fc.constantFrom(0, 0, 5, 10, 15),
  })
  // Sem filtro: se o sorteio não trouxe fase de trabalho, a primeira vira trabalho.
  .map((service) =>
    service.phases.some((phase) => phase.kind === 'work')
      ? service
      : {
          ...service,
          phases: service.phases.map((phase, index) =>
            index === 0 ? { ...phase, kind: 'work' as const } : phase,
          ),
        },
  );

/** Serviço com pausa no meio (trabalho, pausa, trabalho), para a propriedade da pausa. */
export const serviceWithPauseArb: fc.Arbitrary<ServiceDefinition> = fc
  .record({
    before: fc.constantFrom(0, 5, 10),
    first: fc.constantFrom(15, 20, 30),
    pause: fc.constantFrom(15, 30, 40),
    last: fc.constantFrom(15, 20, 30),
    after: fc.constantFrom(0, 5, 10),
  })
  .map(({ before, first, pause, last, after }) => ({
    phases: [
      { kind: 'work', minutes: first },
      { kind: 'pause', minutes: pause },
      { kind: 'work', minutes: last },
    ],
    bufferBeforeMinutes: before,
    bufferAfterMinutes: after,
  }));

// Vigência só às vezes (o comum é turno sem data de início nem fim).
const validityArb = fc.oneof(
  { weight: 4, arbitrary: fc.constant(undefined) },
  {
    weight: 1,
    arbitrary: fc.record({
      fromOffsetDays: fc.option(fc.integer({ min: -2, max: 3 }), { nil: undefined }),
      untilOffsetDays: fc.option(fc.integer({ min: -1, max: 4 }), { nil: undefined }),
    }),
  },
);

const rawShiftArb = fc.record({
  // Dia da semana relativo à primeira data. 0 a 2 caem dentro do intervalo pedido (ver o
  // map abaixo); 3 a 6 caem fora e exercitam turnos inativos.
  dayOffset: fc.oneof(
    { weight: 5, arbitrary: fc.integer({ min: 0, max: 2 }) },
    { weight: 1, arbitrary: fc.integer({ min: 3, max: 6 }) },
  ),
  minutes: fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        startMinute: fc.integer({ min: 0, max: 1439 }),
        lengthMinutes: fc.integer({ min: 1, max: 720 }),
      }),
    },
    // Dia inteiro (00:00-24:00): sempre cobre a hora da transição de horário de verão.
    { weight: 1, arbitrary: fc.constant({ startMinute: 0, lengthMinutes: 1440 }) },
  ),
  validity: validityArb,
});

const rawRangeArb = fc.record({
  offsetMinutes: fc.integer({ min: -180, max: 3 * 1440 + 180 }),
  lengthMinutes: fc.integer({ min: 1, max: 180 }),
  noiseNs: subMinuteNoiseNsArb,
  endNoiseNs: subMinuteNoiseNsArb,
});

interface ArbitraryOptions {
  readonly zoneAndDate?: fc.Arbitrary<ZoneAndDate>;
  readonly service?: fc.Arbitrary<ServiceDefinition>;
}

/**
 * Pedidos de disponibilidade realistas e hostis: 1 a 3 dias, turnos com vigência,
 * serviços com fases e buffers, ocupações e bloqueios com precisão de nanossegundo,
 * "agora" antes, durante ou depois do intervalo, grades que não dividem a hora.
 */
export function availabilityInputArb(
  options: ArbitraryOptions = {},
): fc.Arbitrary<AvailabilityInput> {
  const { zoneAndDate = zoneAndDateArb(), service = serviceArb } = options;
  return fc
    .record({
      zoneAndDate,
      extraDays: fc.integer({ min: 0, max: 2 }),
      shifts: fc.array(rawShiftArb, { minLength: 1, maxLength: 4 }),
      service,
      busy: fc.array(rawRangeArb, { maxLength: 6 }),
      timeOff: fc.array(rawRangeArb, { maxLength: 2 }),
      granularityMinutes: fc.constantFrom(5, 10, 15, 20, 30, 60, 7, 25, 45),
      minNoticeMinutes: fc.constantFrom(0, 0, 15, 30, 120, 1440),
      maxAdvanceMinutes: fc.oneof(
        { weight: 5, arbitrary: fc.constantFrom(10_080, 86_400) },
        { weight: 1, arbitrary: fc.constantFrom(0, 60, 600, 1440, 2880) },
      ),
      // "Agora" quase sempre antes do intervalo pedido; às vezes no meio dele ou depois.
      nowOffsetMinutes: fc.oneof(
        { weight: 5, arbitrary: fc.integer({ min: -3 * 1440, max: 0 }) },
        { weight: 1, arbitrary: fc.integer({ min: 0, max: 3 * 1440 }) },
      ),
      nowNoiseNs: subMinuteNoiseNsArb,
    })
    .map(({ zoneAndDate: { timeZone, from }, ...raw }): AvailabilityInput => {
      const dayStartNs = from.toZonedDateTime({ timeZone }).epochNanoseconds;
      const at = (minutes: number, noiseNs: bigint): Temporal.Instant =>
        Temporal.Instant.fromEpochNanoseconds(
          dayStartNs + BigInt(minutes) * NS_PER_MINUTE + noiseNs,
        );
      const toInterval = (r: (typeof raw.busy)[number]): Interval => ({
        start: at(r.offsetMinutes, r.noiseNs),
        end: at(r.offsetMinutes + r.lengthMinutes, r.endNoiseNs),
      });
      return {
        timeZone,
        from,
        to: from.add({ days: raw.extraDays }),
        weeklySchedule: raw.shifts.map((shift): WorkShift => {
          const dayOffset =
            shift.dayOffset <= 2 ? shift.dayOffset % (raw.extraDays + 1) : shift.dayOffset;
          const isoWeekday = (((from.dayOfWeek - 1 + dayOffset) % 7) + 1) as IsoWeekday;
          const { startMinute, lengthMinutes } = shift.minutes;
          const endMinute = Math.min(1440, startMinute + lengthMinutes);
          const validFrom =
            shift.validity?.fromOffsetDays === undefined
              ? undefined
              : from.add({ days: shift.validity.fromOffsetDays });
          const validUntilRaw =
            shift.validity?.untilOffsetDays === undefined
              ? undefined
              : from.add({ days: shift.validity.untilOffsetDays });
          // Vigência invertida é entrada inválida; aqui só geramos válidas.
          const validUntil =
            validFrom !== undefined &&
            validUntilRaw !== undefined &&
            Temporal.PlainDate.compare(validUntilRaw, validFrom) < 0
              ? validFrom
              : validUntilRaw;
          return {
            isoWeekday,
            start: hhmm(startMinute),
            end: hhmm(endMinute),
            ...(validFrom === undefined ? {} : { validFrom }),
            ...(validUntil === undefined ? {} : { validUntil }),
          };
        }),
        service: raw.service,
        busy: raw.busy.map(toInterval),
        timeOff: raw.timeOff.map(toInterval),
        granularityMinutes: raw.granularityMinutes,
        minNoticeMinutes: raw.minNoticeMinutes,
        maxAdvanceMinutes: raw.maxAdvanceMinutes,
        clock: fixedClock(at(raw.nowOffsetMinutes, raw.nowNoiseNs)),
      };
    });
}

/** Intervalo extra (nova ocupação) relativo ao início do primeiro dia do pedido. */
export const extraBusyArb = fc.record({
  offsetMinutes: fc.integer({ min: -60, max: 3 * 1440 }),
  lengthMinutes: fc.integer({ min: 1, max: 180 }),
});
