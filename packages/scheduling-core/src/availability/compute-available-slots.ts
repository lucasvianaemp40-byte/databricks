import { Temporal } from 'temporal-polyfill';
import { assertIntegerInRange, SchedulingInputError } from '../errors';
import type { Clock } from '../time/clock';
import { ceilEpochMs, floorEpochMs } from '../time/epoch';
import { type Interval, intersectIntervals, interval, mergeIntervals } from '../time/intervals';
import {
  assertIanaTimeZone,
  assertIsoDate,
  type LocalDayFrame,
  localDayFrame,
  MINUTE_MS,
  wallMinuteToEpochMs,
} from '../time/local-day';
import { formatWallTime, MINUTES_PER_DAY, parseWallTime } from '../time/wall-time';
import { type ServiceDefinition, serviceFootprint } from './service';

/** Dia da semana ISO 8601: 1 = segunda ... 7 = domingo (igual ao Postgres e ao Temporal). */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Turno da jornada semanal, em hora de parede do fuso da unidade.
 * O almoço é representado por dois turnos no mesmo dia. Turno que vira a meia-noite está
 * fora do escopo (use '24:00' como fim e '00:00' no dia seguinte; não se unem).
 */
export interface WorkShift {
  readonly isoWeekday: IsoWeekday;
  /** 'HH:MM' (00:00 a 23:59). */
  readonly start: string;
  /** 'HH:MM' ou '24:00' (fim do dia local); maior que `start`. */
  readonly end: string;
  /** Primeira data local em que o turno vale (inclusiva). Ausente = sem início. */
  readonly validFrom?: Temporal.PlainDate;
  /** Última data local em que o turno vale (inclusiva). Ausente = sem fim. */
  readonly validUntil?: Temporal.PlainDate;
}

/** Pedido de disponibilidade de UM profissional para UM serviço num intervalo de datas locais. */
export interface AvailabilityInput {
  /** Fuso IANA da unidade (ex.: 'America/Sao_Paulo'). Nunca o do navegador ou do servidor. */
  readonly timeZone: string;
  /** Primeira data local consultada (inclusiva). */
  readonly from: Temporal.PlainDate;
  /** Última data local consultada (inclusiva). No máximo {@link MAX_RANGE_DAYS} datas. */
  readonly to: Temporal.PlainDate;
  readonly weeklySchedule: readonly WorkShift[];
  readonly service: ServiceDefinition;
  /** Ocupações existentes do profissional (alocações ativas, já com os buffers delas). */
  readonly busy: readonly Interval[];
  /** Folgas, férias e bloqueios do profissional ou da unidade. */
  readonly timeOff: readonly Interval[];
  /** Passo da grade em minutos (1 a 1440), contado a partir de 00:00 do relógio local. */
  readonly granularityMinutes: number;
  /** Antecedência mínima: início >= agora + isto. */
  readonly minNoticeMinutes: number;
  /** Horizonte: início <= agora + isto (dias do banco x 1440). */
  readonly maxAdvanceMinutes: number;
  /** Fonte de "agora", lida uma única vez por cálculo. */
  readonly clock: Clock;
}

/** Horário oferecido ao cliente. */
export interface AvailableSlot {
  /** Início visível do atendimento (instante absoluto). */
  readonly start: Temporal.Instant;
  /** Fim visível do atendimento (start + duração do serviço, sem buffers). */
  readonly end: Temporal.Instant;
  /** Data local do início, 'YYYY-MM-DD', no fuso da unidade. */
  readonly localDate: string;
  /** Hora local do início, 'HH:MM', no fuso da unidade. */
  readonly localTime: string;
  /**
   * Offset UTC no início, ex.: '-03:00'. Desambigua rótulos repetidos quando o horário de
   * verão termina (01:30 acontece duas vezes) e deve ser gravado junto com a hora local.
   */
  readonly utcOffset: string;
}

/** Limite de datas por consulta (defesa contra consultas abusivas: ASVS, limites de recurso). */
export const MAX_RANGE_DAYS = 366;

/** Teto para antecedência e horizonte: 2 anos em minutos. */
const MAX_NOTICE_MINUTES = 2 * 366 * MINUTES_PER_DAY;

interface ParsedShift {
  readonly isoWeekday: number;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly validFrom: Temporal.PlainDate | undefined;
  readonly validUntil: Temporal.PlainDate | undefined;
}

/** Intervalo em epoch ms inteiros (uso interno). */
interface EpochRange {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Horários livres de um profissional para um serviço, em ordem cronológica.
 *
 * Um início `t` é oferecido quando TODAS as condições valem:
 *   1. `t` está na grade do relógio local: minutos desde 00:00 local múltiplos da
 *      granularidade. Rótulos inexistentes (lacuna do horário de verão) não geram horário;
 *      rótulos repetidos (hora ambígua) geram dois horários, com offsets diferentes.
 *   2. O atendimento visível [t, t + duração) cabe inteiro num turno do dia local de `t`
 *      (turnos sobrepostos ou encostados são unidos). Os limites do turno viram instantes
 *      pela regra de {@link wallMinuteToEpochMs} (primeiro instante em que o relógio marca
 *      >= o horário: lacuna -> transição; ambíguo -> primeira ocorrência).
 *   3. Nenhum trecho em que o profissional fica ocupado (buffer de preparo, fases de
 *      trabalho, buffer de limpeza) toca uma ocupação ou um bloqueio. Pausas não ocupam.
 *      Buffers podem passar do limite do turno (preparo antes de abrir, limpeza depois de
 *      fechar), mas nunca colidir com ocupação ou bloqueio.
 *   4. agora + antecedência <= t <= agora + horizonte, com "agora" lido uma vez do Clock.
 *
 * Função pura e determinística: mesma entrada (e mesmo instante do Clock), mesma saída.
 * Todas as comparações são exatas: os candidatos caem em milissegundos inteiros, então
 * arredondar as bordas de ocupações para fora (e as da região permitida para dentro) não
 * muda nenhuma decisão, mesmo com instantes de entrada em nanossegundos.
 *
 * @throws {SchedulingInputError} entrada inválida (fuso, datas, horários, durações).
 */
export function computeAvailableSlots(input: AvailabilityInput): readonly AvailableSlot[] {
  const parsedShifts = validateInput(input);
  const footprint = serviceFootprint(input.service);

  const now = input.clock.now();
  const earliestStart = now.add({ minutes: input.minNoticeMinutes });
  const latestStart = now.add({ minutes: input.maxAdvanceMinutes });
  if (Temporal.Instant.compare(latestStart, earliestStart) < 0) return [];
  // Onde o atendimento visível pode acontecer: começa em >= earliestStart e em <= latestStart.
  const bookable = interval(earliestStart, latestStart.add({ minutes: footprint.durationMinutes }));

  const unavailable = mergeIntervals([...input.busy, ...input.timeOff]).map(
    (x): EpochRange => ({ startMs: floorEpochMs(x.start), endMs: ceilEpochMs(x.end) }),
  );
  const context: SearchContext = {
    stepMs: input.granularityMinutes * MINUTE_MS,
    durationMs: footprint.durationMinutes * MINUTE_MS,
    busyOffsets: footprint.staffBusy.map(
      (range): EpochRange => ({
        startMs: range.startMinute * MINUTE_MS,
        endMs: range.endMinute * MINUTE_MS,
      }),
    ),
    unavailable,
  };

  const slots: AvailableSlot[] = [];
  for (
    let date = input.from;
    Temporal.PlainDate.compare(date, input.to) <= 0;
    date = date.add({ days: 1 })
  ) {
    const shifts = parsedShifts.filter((shift) => isActiveOn(shift, date));
    if (shifts.length === 0) continue;

    const frame = localDayFrame(date, input.timeZone);
    const windows = shifts.map((shift) =>
      interval(
        Temporal.Instant.fromEpochMilliseconds(wallMinuteToEpochMs(frame, shift.startMinute)),
        Temporal.Instant.fromEpochMilliseconds(wallMinuteToEpochMs(frame, shift.endMinute)),
      ),
    );
    for (const region of intersectIntervals(windows, [bookable])) {
      collectSlots(frame, region, context, slots);
    }
  }
  return slots;
}

interface SearchContext {
  readonly stepMs: number;
  readonly durationMs: number;
  /** Trechos ocupados do profissional relativos ao início (ms). */
  readonly busyOffsets: readonly EpochRange[];
  /** Ocupações + bloqueios unidos, ordenados, arredondados para fora (ms). */
  readonly unavailable: readonly EpochRange[];
}

/** Acrescenta a `out` os horários livres cujo atendimento visível cabe em `region`. */
function collectSlots(
  frame: LocalDayFrame,
  region: Interval,
  context: SearchContext,
  out: AvailableSlot[],
): void {
  const { stepMs, durationMs } = context;
  const firstStartMs = ceilEpochMs(region.start);
  const lastStartMs = floorEpochMs(region.end) - durationMs;
  const localDate = frame.date.toString();

  for (const segment of frame.segments) {
    const lo = Math.max(firstStartMs, segment.startMs);
    const hi = Math.min(lastStartMs, segment.endMs - 1);
    if (lo > hi) continue;
    // Neste trecho, relógio local = instante + offset. "Meia-noite local + k passos" no
    // relógio corresponde aos instantes base + k passos.
    const base = frame.wallMidnightMs - segment.offsetMs;
    for (let t = base + Math.ceil((lo - base) / stepMs) * stepMs; t <= hi; t += stepMs) {
      if (!isStaffFree(t, context)) continue;
      out.push({
        start: Temporal.Instant.fromEpochMilliseconds(t),
        end: Temporal.Instant.fromEpochMilliseconds(t + durationMs),
        localDate,
        localTime: formatWallTime((t - base) / MINUTE_MS),
        utcOffset: segment.offset,
      });
    }
  }
}

function isStaffFree(startMs: number, context: SearchContext): boolean {
  return context.busyOffsets.every(
    (piece) => !overlapsAny(context.unavailable, startMs + piece.startMs, startMs + piece.endMs),
  );
}

/**
 * Existe faixa em `ranges` que intersecta [startMs, endMs)? `ranges` vem ordenado com
 * inícios e fins não decrescentes (união normalizada), o que permite busca binária.
 */
function overlapsAny(ranges: readonly EpochRange[], startMs: number, endMs: number): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((ranges[middle]?.endMs ?? Number.POSITIVE_INFINITY) <= startMs) low = middle + 1;
    else high = middle;
  }
  const candidate = ranges[low];
  return candidate !== undefined && candidate.startMs < endMs;
}

/** O turno vale nesta data: mesmo dia da semana ISO e dentro da vigência (inclusiva). */
function isActiveOn(shift: ParsedShift, date: Temporal.PlainDate): boolean {
  return (
    shift.isoWeekday === date.dayOfWeek &&
    (shift.validFrom === undefined || Temporal.PlainDate.compare(shift.validFrom, date) <= 0) &&
    (shift.validUntil === undefined || Temporal.PlainDate.compare(date, shift.validUntil) <= 0)
  );
}

/** Valida tudo antes de calcular e devolve os turnos já convertidos para minutos. */
function validateInput(input: AvailabilityInput): readonly ParsedShift[] {
  assertIanaTimeZone(input.timeZone);
  assertIsoDate('from', input.from);
  assertIsoDate('to', input.to);
  if (Temporal.PlainDate.compare(input.from, input.to) > 0) {
    throw new SchedulingInputError('from', 'a data inicial é posterior à final');
  }
  const days = input.from.until(input.to, { largestUnit: 'days' }).days + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new SchedulingInputError('to', `consulta de ${days} datas; o máximo é ${MAX_RANGE_DAYS}`);
  }
  assertIntegerInRange('granularityMinutes', input.granularityMinutes, 1, MINUTES_PER_DAY);
  assertIntegerInRange('minNoticeMinutes', input.minNoticeMinutes, 0, MAX_NOTICE_MINUTES);
  assertIntegerInRange('maxAdvanceMinutes', input.maxAdvanceMinutes, 0, MAX_NOTICE_MINUTES);
  assertIntervals('busy', input.busy);
  assertIntervals('timeOff', input.timeOff);

  const parsed: ParsedShift[] = [];
  for (const [index, shift] of input.weeklySchedule.entries()) {
    const field = `weeklySchedule[${index}]`;
    assertIntegerInRange(`${field}.isoWeekday`, shift.isoWeekday, 1, 7);
    const startMinute = parseWallTime(shift.start, { field: `${field}.start` });
    const endMinute = parseWallTime(shift.end, { allowEndOfDay: true, field: `${field}.end` });
    if (endMinute <= startMinute) {
      throw new SchedulingInputError(`${field}.end`, 'o fim do turno precisa ser depois do início');
    }
    const { validFrom, validUntil } = shift;
    if (validFrom !== undefined) assertIsoDate(`${field}.validFrom`, validFrom);
    if (validUntil !== undefined) assertIsoDate(`${field}.validUntil`, validUntil);
    if (
      validFrom !== undefined &&
      validUntil !== undefined &&
      Temporal.PlainDate.compare(validUntil, validFrom) < 0
    ) {
      throw new SchedulingInputError(`${field}.validUntil`, 'vigência termina antes de começar');
    }
    parsed.push({ isoWeekday: shift.isoWeekday, startMinute, endMinute, validFrom, validUntil });
  }
  return parsed;
}

function assertIntervals(field: string, intervals: readonly Interval[]): void {
  for (const [index, x] of intervals.entries()) {
    if (Temporal.Instant.compare(x.end, x.start) < 0) {
      throw new SchedulingInputError(`${field}[${index}]`, 'fim antes do início');
    }
  }
}
