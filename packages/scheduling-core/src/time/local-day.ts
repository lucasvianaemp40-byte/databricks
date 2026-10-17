import { Temporal } from 'temporal-polyfill';
import { SchedulingInputError } from '../errors';
import { parseWallTime } from './wall-time';

export const MINUTE_MS = 60_000;
const NS_PER_MS = 1_000_000;

/** Trecho do dia local com offset UTC constante: relógio de parede = instante + offset. */
interface OffsetSegment {
  /** Primeiro instante do trecho (epoch ms, inclusivo). */
  readonly startMs: number;
  /** Fim do trecho (epoch ms, exclusivo): a próxima transição ou o fim do dia. */
  readonly endMs: number;
  readonly offsetMs: number;
  /** Offset no formato do Temporal, ex.: '-03:00'. */
  readonly offset: string;
}

/**
 * Um dia local num fuso IANA, como trecho da linha do tempo absoluta.
 *
 * O dia vai do primeiro instante da data local até o primeiro instante da data seguinte.
 * Num dia com transição de horário de verão ele tem 23 h ou 25 h (ou 23,5 h em Lord Howe)
 * e mais de um trecho de offset. Um dia que não existiu (Pacific/Apia, 2011-12-30) tem
 * duração zero e nenhum trecho.
 *
 * Calculado uma vez por dia com Temporal; o motor de disponibilidade faz o resto com
 * aritmética exata de milissegundos dentro de cada trecho.
 */
export interface LocalDayFrame {
  readonly date: Temporal.PlainDate;
  readonly startMs: number;
  readonly endMs: number;
  /** 00:00 da data como se fosse UTC: referência para a leitura do relógio de parede. */
  readonly wallMidnightMs: number;
  readonly segments: readonly OffsetSegment[];
}

/**
 * Exige um identificador IANA (ex.: 'America/Sao_Paulo') ou 'UTC'.
 * Offset fixo ('-03:00') é recusado: horário de verão pode voltar e o fuso da unidade
 * precisa acompanhar o tzdata.
 */
export function assertIanaTimeZone(timeZone: string, field = 'timeZone'): void {
  if (!/^[A-Za-z]/.test(timeZone)) {
    throw new SchedulingInputError(field, `fuso inválido "${timeZone}": use um nome IANA`);
  }
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone);
  } catch (cause) {
    throw new SchedulingInputError(field, `fuso desconhecido "${timeZone}"`, { cause });
  }
}

/** Exige data no calendário ISO 8601 (dia da semana ISO e rótulos 'YYYY-MM-DD'). */
export function assertIsoDate(field: string, date: Temporal.PlainDate): void {
  if (date.calendarId !== 'iso8601') {
    throw new SchedulingInputError(
      field,
      `calendário "${date.calendarId}" não suportado (use ISO 8601)`,
    );
  }
}

/** Estrutura do dia local `date` no fuso `timeZone` (já validados pelo chamador). */
export function localDayFrame(date: Temporal.PlainDate, timeZone: string): LocalDayFrame {
  const start = date.toZonedDateTime({ timeZone });
  const end = date.add({ days: 1 }).toZonedDateTime({ timeZone });
  const segments: OffsetSegment[] = [];
  let cursor = start;
  while (Temporal.ZonedDateTime.compare(cursor, end) < 0) {
    const transition = cursor.getTimeZoneTransition('next');
    const segmentEnd =
      transition !== null && Temporal.ZonedDateTime.compare(transition, end) < 0 ? transition : end;
    segments.push({
      startMs: cursor.epochMilliseconds,
      endMs: segmentEnd.epochMilliseconds,
      // Offsets IANA têm resolução de segundos: a divisão é exata.
      offsetMs: cursor.offsetNanoseconds / NS_PER_MS,
      offset: cursor.offset,
    });
    cursor = segmentEnd;
  }
  return {
    date,
    startMs: start.epochMilliseconds,
    endMs: end.epochMilliseconds,
    wallMidnightMs: date.toZonedDateTime({ timeZone: 'UTC' }).epochMilliseconds,
    segments,
  };
}

/**
 * Converte "minuto do dia no relógio de parede" em instante (epoch ms).
 *
 * Regra única, explícita e monotônica: o resultado é o PRIMEIRO instante do dia local em
 * que o relógio da unidade marca um horário >= o pedido.
 *   - Horário comum: o instante único correspondente.
 *   - Horário ambíguo (fim do horário de verão, a hora se repete): a primeira ocorrência.
 *   - Horário inexistente (início do horário de verão, o relógio pula): o instante da
 *     transição, que é quando o relógio passa a marcar algo >= o pedido.
 *   - 1440 (24:00): o fim do dia local.
 * Por ser monotônica, um turno [início, fim) com início < fim nunca vira intervalo
 * invertido, ao contrário da desambiguação 'compatible' do Temporal (que, numa lacuna,
 * empurra 02:30 para 03:30 e deixaria [02:30, 03:15) ao contrário).
 */
export function wallMinuteToEpochMs(frame: LocalDayFrame, minuteOfDay: number): number {
  const wallMs = frame.wallMidnightMs + minuteOfDay * MINUTE_MS;
  for (const segment of frame.segments) {
    const candidate = Math.max(segment.startMs, wallMs - segment.offsetMs);
    if (candidate < segment.endMs) return candidate;
  }
  return frame.endMs;
}

/**
 * Instante em que começa a hora de parede `wallTime` ('HH:MM' ou '24:00') na data local
 * `date` do fuso IANA `timeZone`, pela regra de {@link wallMinuteToEpochMs}.
 * Útil para converter um horário digitado pela recepção.
 */
export function wallTimeToInstant(
  date: Temporal.PlainDate,
  wallTime: string,
  timeZone: string,
): Temporal.Instant {
  assertIanaTimeZone(timeZone);
  assertIsoDate('date', date);
  const minute = parseWallTime(wallTime, { allowEndOfDay: true });
  const frame = localDayFrame(date, timeZone);
  return Temporal.Instant.fromEpochMilliseconds(wallMinuteToEpochMs(frame, minute));
}
