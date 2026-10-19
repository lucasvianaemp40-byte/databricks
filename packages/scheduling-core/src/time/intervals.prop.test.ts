import { fc, it } from '@fast-check/vitest';
import { Temporal } from 'temporal-polyfill';
import { describe, expect } from 'vitest';
import {
  compareIntervals,
  containsInterval,
  type Interval,
  intersectIntervals,
  isEmptyInterval,
  mergeIntervals,
  overlaps,
  sortIntervals,
  subtractIntervals,
} from './intervals';

// Linha do tempo pequena (0 a 60 min) para forçar colisões, encostos e vazios, com ruído
// ocasional de nanossegundos.
const BASE_NS = Temporal.Instant.from('2026-11-03T12:00:00Z').epochNanoseconds;
const instantArb = fc
  .tuple(fc.integer({ min: 0, max: 60 }), fc.constantFrom(0n, 0n, 0n, 1n, 999_999n))
  .map(([minutes, noise]) =>
    Temporal.Instant.fromEpochNanoseconds(BASE_NS + BigInt(minutes) * 60_000_000_000n + noise),
  );
const intervalArb: fc.Arbitrary<Interval> = fc
  .tuple(instantArb, instantArb)
  .map(([a, b]) =>
    Temporal.Instant.compare(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a },
  );
const setArb = fc.array(intervalArb, { maxLength: 8 });

const contains = (xs: readonly Interval[], p: Temporal.Instant): boolean =>
  xs.some(
    (x) => Temporal.Instant.compare(x.start, p) <= 0 && Temporal.Instant.compare(p, x.end) < 0,
  );

/**
 * Pontos onde a pertinência pode mudar: todas as bordas, mais um antes de tudo. Uniões de
 * intervalos semiabertos são constantes entre bordas consecutivas, então checar nesses
 * pontos prova igualdade de conjuntos (não é amostragem).
 */
const criticalPoints = (...sets: (readonly Interval[])[]): Temporal.Instant[] => [
  Temporal.Instant.fromEpochNanoseconds(BASE_NS - 1n),
  ...sets.flat().flatMap((x) => [x.start, x.end]),
];

const expectNormalized = (xs: readonly Interval[]): void => {
  for (const [index, x] of xs.entries()) {
    expect(isEmptyInterval(x)).toBe(false);
    const previous = xs[index - 1];
    // Ordenado e com buraco real entre vizinhos (nem sobreposto nem encostado).
    if (previous !== undefined) {
      expect(Temporal.Instant.compare(previous.end, x.start)).toBe(-1);
    }
  }
};

const show = (xs: readonly Interval[]): string[] =>
  xs.map((x) => `${x.start.toString()}/${x.end.toString()}`);

describe('álgebra de intervalos (propriedades)', { tags: ['property'] }, () => {
  it.prop([setArb])('mergeIntervals deve normalizar sem mudar o conjunto de instantes', (xs) => {
    const merged = mergeIntervals(xs);
    expectNormalized(merged);
    for (const p of criticalPoints(xs, merged)) expect(contains(merged, p)).toBe(contains(xs, p));
  });

  it.prop([setArb])('mergeIntervals deve ser idempotente e indiferente à ordem', (xs) => {
    const merged = mergeIntervals(xs);
    expect(show(mergeIntervals(merged))).toEqual(show(merged));
    expect(show(mergeIntervals([...xs].reverse()))).toEqual(show(merged));
  });

  it.prop([setArb, setArb])(
    'intersectIntervals deve conter exatamente o que está nos dois',
    (a, b) => {
      const result = intersectIntervals(a, b);
      expectNormalized(result);
      for (const p of criticalPoints(a, b, result)) {
        expect(contains(result, p)).toBe(contains(a, p) && contains(b, p));
      }
      expect(show(intersectIntervals(b, a))).toEqual(show(result));
    },
  );

  it.prop([setArb, setArb])('subtractIntervals deve conter o que está em a e não em b', (a, b) => {
    const result = subtractIntervals(a, b);
    expectNormalized(result);
    for (const p of criticalPoints(a, b, result)) {
      expect(contains(result, p)).toBe(contains(a, p) && !contains(b, p));
    }
  });

  it.prop([setArb, setArb])('a deve ser a união disjunta de (a - b) e (a ∩ b)', (a, b) => {
    const minus = subtractIntervals(a, b);
    const both = intersectIntervals(a, b);
    expect(intersectIntervals(minus, both)).toEqual([]);
    expect(show(mergeIntervals([...minus, ...both]))).toEqual(show(mergeIntervals(a)));
  });

  it.prop([intervalArb, intervalArb])(
    'overlaps deve ser simétrico e equivaler a interseção não vazia',
    (a, b) => {
      expect(overlaps(a, b)).toBe(overlaps(b, a));
      expect(overlaps(a, b)).toBe(intersectIntervals([a], [b]).length > 0);
    },
  );

  it.prop([intervalArb, intervalArb])(
    'containsInterval deve equivaler a "nada sobra de inner fora de outer"',
    (outer, inner) => {
      expect(containsInterval(outer, inner)).toBe(subtractIntervals([inner], [outer]).length === 0);
    },
  );

  it.prop([setArb])('sortIntervals deve ser permutação ordenada por compareIntervals', (xs) => {
    const sorted = sortIntervals(xs);
    expect([...show(sorted)].sort()).toEqual([...show(xs)].sort());
    for (const [index, x] of sorted.entries()) {
      const previous = sorted[index - 1];
      if (previous !== undefined) expect(compareIntervals(previous, x)).toBeLessThanOrEqual(0);
      expect(compareIntervals(x, x)).toBe(0);
    }
  });

  it.prop([setArb, setArb])('nenhuma operação deve alterar a entrada', (a, b) => {
    const frozenA = Object.freeze(a.map((x) => Object.freeze({ ...x })));
    const frozenB = Object.freeze(b.map((x) => Object.freeze({ ...x })));
    const before = [show(frozenA), show(frozenB)];
    sortIntervals(frozenA);
    mergeIntervals(frozenA);
    intersectIntervals(frozenA, frozenB);
    subtractIntervals(frozenA, frozenB);
    expect([show(frozenA), show(frozenB)]).toEqual(before);
  });
});
