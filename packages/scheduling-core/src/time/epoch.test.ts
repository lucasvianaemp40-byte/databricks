import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { ceilEpochMs, floorEpochMs } from './epoch';

const ns = (value: bigint) => Temporal.Instant.fromEpochNanoseconds(value);

describe('floorEpochMs / ceilEpochMs', () => {
  it('não deve arredondar milissegundo inteiro', () => {
    expect(floorEpochMs(ns(5_000_000n))).toBe(5);
    expect(ceilEpochMs(ns(5_000_000n))).toBe(5);
  });

  it('deve arredondar frações de milissegundo para baixo e para cima', () => {
    expect(floorEpochMs(ns(5_000_001n))).toBe(5);
    expect(ceilEpochMs(ns(5_000_001n))).toBe(6);
    expect(ceilEpochMs(ns(5_999_999n))).toBe(6);
  });

  it('deve usar piso de verdade antes de 1970 (o Temporal define epochMilliseconds como piso)', () => {
    expect(floorEpochMs(ns(-1n))).toBe(-1);
    expect(ceilEpochMs(ns(-1n))).toBe(0);
    expect(floorEpochMs(ns(-1_000_001n))).toBe(-2);
    expect(ceilEpochMs(ns(-1_000_001n))).toBe(-1);
  });
});
