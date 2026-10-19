import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  compareIntervals,
  containsInterval,
  type Interval,
  intersectIntervals,
  interval,
  isEmptyInterval,
  mergeIntervals,
  overlaps,
  sortIntervals,
  subtractIntervals,
} from './intervals';

// Instantes legíveis: minutos a partir de 2026-11-03T09:00Z (só para os exemplos).
const BASE = Temporal.Instant.from('2026-11-03T09:00:00Z');
const at = (minutes: number): Temporal.Instant => BASE.add({ minutes });
const iv = (startMinutes: number, endMinutes: number): Interval =>
  interval(at(startMinutes), at(endMinutes));
const show = (xs: readonly Interval[]): string[] =>
  xs.map((x) => `${x.start.toString()}/${x.end.toString()}`);

describe('interval', () => {
  it('deve criar um intervalo semiaberto [start, end)', () => {
    const x = iv(0, 30);
    expect(x.start).toEqual(at(0));
    expect(x.end).toEqual(at(30));
  });

  it('deve aceitar intervalo vazio (start = end)', () => {
    expect(isEmptyInterval(iv(10, 10))).toBe(true);
  });

  it('deve rejeitar fim antes do início', () => {
    expect(() => iv(30, 0)).toThrow(RangeError);
  });
});

describe('overlaps', () => {
  it('deve detectar sobreposição parcial', () => {
    expect(overlaps(iv(0, 30), iv(20, 40))).toBe(true);
  });

  it('não deve considerar intervalos encostados como sobrepostos (semiaberto)', () => {
    expect(overlaps(iv(0, 30), iv(30, 60))).toBe(false);
    expect(overlaps(iv(30, 60), iv(0, 30))).toBe(false);
  });

  it('nunca deve haver sobreposição com intervalo vazio', () => {
    expect(overlaps(iv(10, 10), iv(0, 30))).toBe(false);
    expect(overlaps(iv(0, 30), iv(10, 10))).toBe(false);
  });

  it('deve considerar a diferença de 1 nanossegundo', () => {
    const a = interval(at(0), at(30).add({ nanoseconds: 1 }));
    expect(overlaps(a, iv(30, 60))).toBe(true);
  });
});

describe('containsInterval', () => {
  it('deve conter intervalo interno e o próprio intervalo', () => {
    expect(containsInterval(iv(0, 60), iv(10, 20))).toBe(true);
    expect(containsInterval(iv(0, 60), iv(0, 60))).toBe(true);
  });

  it('não deve conter intervalo que ultrapassa a borda', () => {
    expect(containsInterval(iv(0, 60), iv(50, 70))).toBe(false);
    expect(containsInterval(iv(10, 60), iv(0, 20))).toBe(false);
  });

  it('deve conter o vazio (vacuamente) e o vazio não contém nada não vazio', () => {
    expect(containsInterval(iv(0, 60), iv(90, 90))).toBe(true);
    expect(containsInterval(iv(5, 5), iv(0, 10))).toBe(false);
  });
});

describe('sortIntervals / compareIntervals', () => {
  it('deve ordenar por início e, no empate, por fim, sem alterar a entrada', () => {
    const input = [iv(30, 40), iv(0, 50), iv(0, 10)];
    const snapshot = show(input);
    expect(show(sortIntervals(input))).toEqual(show([iv(0, 10), iv(0, 50), iv(30, 40)]));
    expect(show(input)).toEqual(snapshot);
    expect(compareIntervals(iv(0, 10), iv(0, 10))).toBe(0);
  });
});

describe('mergeIntervals', () => {
  it('deve unir sobrepostos e encostados, descartar vazios e ordenar', () => {
    const merged = mergeIntervals([iv(50, 60), iv(0, 10), iv(10, 20), iv(15, 30), iv(40, 40)]);
    expect(show(merged)).toEqual(show([iv(0, 30), iv(50, 60)]));
  });

  it('deve devolver lista vazia para entrada vazia', () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it('deve absorver intervalo contido em outro', () => {
    expect(show(mergeIntervals([iv(0, 100), iv(10, 20)]))).toEqual(show([iv(0, 100)]));
  });
});

describe('intersectIntervals', () => {
  it('deve devolver só o que está nos dois conjuntos', () => {
    const result = intersectIntervals([iv(0, 30), iv(60, 90)], [iv(20, 70)]);
    expect(show(result)).toEqual(show([iv(20, 30), iv(60, 70)]));
  });

  it('deve devolver vazio quando os conjuntos só se encostam', () => {
    expect(intersectIntervals([iv(0, 30)], [iv(30, 60)])).toEqual([]);
  });

  it('deve normalizar entradas desordenadas e sobrepostas', () => {
    const result = intersectIntervals([iv(40, 50), iv(0, 20), iv(10, 30)], [iv(0, 100)]);
    expect(show(result)).toEqual(show([iv(0, 30), iv(40, 50)]));
  });
});

describe('subtractIntervals', () => {
  it('deve recortar o meio, as bordas e remover por inteiro', () => {
    const result = subtractIntervals(
      [iv(0, 100), iv(200, 210)],
      [iv(-10, 10), iv(40, 50), iv(90, 120), iv(195, 215)],
    );
    expect(show(result)).toEqual(show([iv(10, 40), iv(50, 90)]));
  });

  it('não deve alterar nada quando o subtraendo só encosta', () => {
    expect(show(subtractIntervals([iv(0, 30)], [iv(30, 60), iv(-30, 0)]))).toEqual(
      show([iv(0, 30)]),
    );
  });

  it('deve tratar um subtraendo que atravessa vários minuendos', () => {
    const result = subtractIntervals([iv(0, 10), iv(20, 30), iv(40, 50)], [iv(5, 45)]);
    expect(show(result)).toEqual(show([iv(0, 5), iv(45, 50)]));
  });

  it('deve funcionar nos limites da linha do tempo do Temporal', () => {
    const first = Temporal.Instant.fromEpochNanoseconds(-8_640_000_000_000_000_000_000n);
    const last = Temporal.Instant.fromEpochNanoseconds(8_640_000_000_000_000_000_000n);
    const everything = interval(first, last);
    expect(subtractIntervals([everything], [everything])).toEqual([]);
    expect(show(subtractIntervals([everything], [iv(0, 10)]))).toEqual(
      show([interval(first, at(0)), interval(at(10), last)]),
    );
  });

  it('deve devolver o minuendo normalizado quando não há o que subtrair', () => {
    expect(show(subtractIntervals([iv(10, 20), iv(0, 10)], []))).toEqual(show([iv(0, 20)]));
  });
});
