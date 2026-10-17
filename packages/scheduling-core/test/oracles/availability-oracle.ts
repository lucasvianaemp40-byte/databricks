import { Temporal } from 'temporal-polyfill';
import type { AvailabilityInput } from '../../src/availability/compute-available-slots';
import type { ServiceDefinition } from '../../src/availability/service';

/**
 * Oráculo de força bruta, independente do motor: usa só Temporal e nanossegundos em
 * bigint (o motor usa quadros de offset por dia e milissegundos). Lento de propósito,
 * escrito para ser obviamente correto, não rápido.
 */

const NS_PER_MINUTE = 60_000_000_000n;
const MINUTES_PER_DAY = 1440;

export interface NsRange {
  readonly start: bigint;
  readonly end: bigint;
}

export interface OracleSlot {
  readonly startNs: bigint;
  readonly endNs: bigint;
  readonly localDate: string;
  readonly localTime: string;
  readonly utcOffset: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const parseMinute = (wall: string): number => {
  const [hours = '', minutes = ''] = wall.split(':');
  return Number(hours) * 60 + Number(minutes);
};

export const rangesOverlap = (a: NsRange, b: NsRange): boolean =>
  a.start < a.end && b.start < b.end && a.start < b.end && b.start < a.end;

/**
 * Regra documentada de hora de parede -> instante, implementada direto com Temporal:
 * existe -> primeira ocorrência ('earlier'); lacuna -> próxima transição; 24:00 -> dia seguinte.
 */
export function oracleWallToInstant(
  date: Temporal.PlainDate,
  minuteOfDay: number,
  timeZone: string,
): Temporal.Instant {
  if (minuteOfDay === MINUTES_PER_DAY) {
    return date.add({ days: 1 }).toZonedDateTime({ timeZone }).toInstant();
  }
  const wall = date.toPlainDateTime({
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
  });
  const earlier = wall.toZonedDateTime(timeZone, { disambiguation: 'earlier' });
  if (earlier.toPlainDateTime().equals(wall)) return earlier.toInstant();
  const transition = earlier.getTimeZoneTransition('next');
  if (transition === null) throw new Error(`lacuna sem transição em ${wall.toString()}`);
  return transition.toInstant();
}

/** Trechos ocupados do profissional relativos ao início visível, em minutos (sem unir). */
export function oracleStaffBusyMinutes(service: ServiceDefinition): readonly [number, number][] {
  const pieces: [number, number][] = [];
  if (service.bufferBeforeMinutes > 0) pieces.push([-service.bufferBeforeMinutes, 0]);
  let offset = 0;
  for (const phase of service.phases) {
    if (phase.kind === 'work') pieces.push([offset, offset + phase.minutes]);
    offset += phase.minutes;
  }
  if (service.bufferAfterMinutes > 0) pieces.push([offset, offset + service.bufferAfterMinutes]);
  return pieces;
}

export function oracleDurationMinutes(service: ServiceDefinition): number {
  return service.phases.reduce((total, phase) => total + phase.minutes, 0);
}

/** Trechos absolutos (ns) que o profissional ocupa se o atendimento começar em `startNs`. */
export function oracleStaffBusyAt(startNs: bigint, service: ServiceDefinition): NsRange[] {
  return oracleStaffBusyMinutes(service).map(([from, to]) => ({
    start: startNs + BigInt(from) * NS_PER_MINUTE,
    end: startNs + BigInt(to) * NS_PER_MINUTE,
  }));
}

export function localDates(input: AvailabilityInput): Temporal.PlainDate[] {
  const dates: Temporal.PlainDate[] = [];
  for (let d = input.from; Temporal.PlainDate.compare(d, input.to) <= 0; d = d.add({ days: 1 })) {
    dates.push(d);
  }
  return dates;
}

/** Janelas de trabalho (unidas) de uma data local, em ns. */
export function oracleWindows(input: AvailabilityInput, date: Temporal.PlainDate): NsRange[] {
  const raw = input.weeklySchedule
    .filter(
      (shift) =>
        shift.isoWeekday === date.dayOfWeek &&
        (shift.validFrom === undefined || Temporal.PlainDate.compare(shift.validFrom, date) <= 0) &&
        (shift.validUntil === undefined || Temporal.PlainDate.compare(date, shift.validUntil) <= 0),
    )
    .map((shift) => ({
      start: oracleWallToInstant(date, parseMinute(shift.start), input.timeZone).epochNanoseconds,
      end: oracleWallToInstant(date, parseMinute(shift.end), input.timeZone).epochNanoseconds,
    }))
    .filter((w) => w.start < w.end)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged: NsRange[] = [];
  for (const w of raw) {
    const last = merged.at(-1);
    if (last !== undefined && w.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: w.end > last.end ? w.end : last.end };
    } else {
      merged.push(w);
    }
  }
  return merged;
}

interface GridPoint {
  readonly startNs: bigint;
  readonly localTime: string;
  readonly utcOffset: string;
}

const gridCache = new Map<string, readonly GridPoint[]>();

/**
 * Todos os instantes cujo relógio local marca 00:00 + k * passo na data: zero (lacuna),
 * um, ou dois (hora repetida) por rótulo.
 */
export function oracleGrid(
  date: Temporal.PlainDate,
  timeZone: string,
  stepMinutes: number,
): readonly GridPoint[] {
  const key = `${timeZone}|${date.toString()}|${stepMinutes}`;
  const cached = gridCache.get(key);
  if (cached !== undefined) return cached;
  const points: GridPoint[] = [];
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += stepMinutes) {
    const wall = date.toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 });
    const seen = new Set<bigint>();
    for (const disambiguation of ['earlier', 'later'] as const) {
      const zoned = wall.toZonedDateTime(timeZone, { disambiguation });
      if (!zoned.toPlainDateTime().equals(wall) || seen.has(zoned.epochNanoseconds)) continue;
      seen.add(zoned.epochNanoseconds);
      points.push({
        startNs: zoned.epochNanoseconds,
        localTime: `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`,
        utcOffset: zoned.offset,
      });
    }
  }
  gridCache.set(key, points);
  return points;
}

/** Resposta esperada, calculada por força bruta. */
export function oracleSlots(input: AvailabilityInput): OracleSlot[] {
  const nowNs = input.clock.now().epochNanoseconds;
  const earliestNs = nowNs + BigInt(input.minNoticeMinutes) * NS_PER_MINUTE;
  const latestNs = nowNs + BigInt(input.maxAdvanceMinutes) * NS_PER_MINUTE;
  const durationNs = BigInt(oracleDurationMinutes(input.service)) * NS_PER_MINUTE;
  const unavailable: NsRange[] = [...input.busy, ...input.timeOff].map((x) => ({
    start: x.start.epochNanoseconds,
    end: x.end.epochNanoseconds,
  }));

  const slots: OracleSlot[] = [];
  for (const date of localDates(input)) {
    const windows = oracleWindows(input, date);
    if (windows.length === 0) continue;
    for (const point of oracleGrid(date, input.timeZone, input.granularityMinutes)) {
      const t = point.startNs;
      if (t < earliestNs || t > latestNs) continue;
      if (!windows.some((w) => w.start <= t && t + durationNs <= w.end)) continue;
      const busy = oracleStaffBusyAt(t, input.service);
      if (busy.some((piece) => unavailable.some((u) => rangesOverlap(piece, u)))) continue;
      slots.push({
        startNs: t,
        endNs: t + durationNs,
        localDate: date.toString(),
        localTime: point.localTime,
        utcOffset: point.utcOffset,
      });
    }
  }
  return slots.sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0));
}
