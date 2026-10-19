import { Temporal } from 'temporal-polyfill';
import { SchedulingInputError } from '../errors';

/**
 * Intervalo semiaberto [start, end) na linha do tempo absoluta.
 *
 * Semiaberto porque encaixa sem buraco nem sobreposição: o atendimento [09:00, 09:30)
 * e o seguinte [09:30, 10:00) não colidem. Mesma semântica do `tstzrange(..., '[)')`
 * do Postgres. Um intervalo com end <= start é vazio e não contém instante algum.
 *
 * Todas as funções deste módulo são puras: não alteram a entrada e devolvem objetos novos.
 */
export interface Interval {
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

const compare = (a: Temporal.Instant, b: Temporal.Instant): number =>
  Temporal.Instant.compare(a, b);
const earliest = (a: Temporal.Instant, b: Temporal.Instant): Temporal.Instant =>
  compare(a, b) <= 0 ? a : b;
const latest = (a: Temporal.Instant, b: Temporal.Instant): Temporal.Instant =>
  compare(a, b) >= 0 ? a : b;

/** Cria [start, end). Aceita vazio (start = end); fim antes do início é erro. */
export function interval(start: Temporal.Instant, end: Temporal.Instant): Interval {
  if (compare(end, start) < 0) {
    throw new SchedulingInputError(
      'interval',
      `fim (${end.toString()}) antes do início (${start.toString()})`,
    );
  }
  return { start, end };
}

/** Verdadeiro quando o intervalo não contém instante algum (end <= start). */
export function isEmptyInterval(x: Interval): boolean {
  return compare(x.end, x.start) <= 0;
}

/** Os dois intervalos têm algum instante em comum. Intervalos encostados não se sobrepõem. */
export function overlaps(a: Interval, b: Interval): boolean {
  return (
    !isEmptyInterval(a) &&
    !isEmptyInterval(b) &&
    compare(a.start, b.end) < 0 &&
    compare(b.start, a.end) < 0
  );
}

/** Todo instante de `inner` está em `outer` (vazio está contido em qualquer intervalo). */
export function containsInterval(outer: Interval, inner: Interval): boolean {
  if (isEmptyInterval(inner)) return true;
  return compare(outer.start, inner.start) <= 0 && compare(inner.end, outer.end) <= 0;
}

/** Ordem total: por início e, no empate, por fim. */
export function compareIntervals(a: Interval, b: Interval): number {
  return compare(a.start, b.start) || compare(a.end, b.end);
}

/** Cópia ordenada por início e fim. */
export function sortIntervals(xs: readonly Interval[]): readonly Interval[] {
  return xs.toSorted(compareIntervals);
}

/**
 * União normalizada: ordenada, sem vazios, sem sobreposição e sem intervalos encostados
 * ([a, b) e [b, c) viram [a, c)). É a forma canônica usada pelas demais operações.
 */
export function mergeIntervals(xs: readonly Interval[]): readonly Interval[] {
  const sorted = xs.filter((x) => !isEmptyInterval(x)).toSorted(compareIntervals);
  const merged: Interval[] = [];
  let current: Interval | undefined;
  for (const x of sorted) {
    if (current !== undefined && compare(x.start, current.end) <= 0) {
      current = { start: current.start, end: latest(current.end, x.end) };
    } else {
      if (current !== undefined) merged.push(current);
      current = { start: x.start, end: x.end };
    }
  }
  if (current !== undefined) merged.push(current);
  return merged;
}

/** Instantes presentes nos dois conjuntos (resultado normalizado). */
export function intersectIntervals(
  a: readonly Interval[],
  b: readonly Interval[],
): readonly Interval[] {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  for (;;) {
    const x = left[i];
    const y = right[j];
    if (x === undefined || y === undefined) break;
    const start = latest(x.start, y.start);
    const end = earliest(x.end, y.end);
    if (compare(start, end) < 0) result.push({ start, end });
    // Avança quem termina primeiro: ele não intersecta mais nada do outro lado.
    if (compare(x.end, y.end) <= 0) i += 1;
    else j += 1;
  }
  return result;
}

/** Instantes de `a` que não estão em `b` (resultado normalizado). */
export function subtractIntervals(
  a: readonly Interval[],
  b: readonly Interval[],
): readonly Interval[] {
  return intersectIntervals(a, complement(b));
}

// Limites da linha do tempo do Temporal (±10^8 dias a partir de 1970).
const FIRST_INSTANT = Temporal.Instant.fromEpochNanoseconds(-8_640_000_000_000_000_000_000n);
const LAST_INSTANT = Temporal.Instant.fromEpochNanoseconds(8_640_000_000_000_000_000_000n);

/** Complemento na linha do tempo inteira: os buracos entre os intervalos (normalizado). */
function complement(xs: readonly Interval[]): readonly Interval[] {
  const gaps: Interval[] = [];
  let cursor = FIRST_INSTANT;
  for (const x of mergeIntervals(xs)) {
    if (compare(cursor, x.start) < 0) gaps.push({ start: cursor, end: x.start });
    cursor = x.end;
  }
  if (compare(cursor, LAST_INSTANT) < 0) gaps.push({ start: cursor, end: LAST_INSTANT });
  return gaps;
}
