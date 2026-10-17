import type { Temporal } from 'temporal-polyfill';

const NS_PER_MS = 1_000_000n;

/** Maior milissegundo inteiro <= instante. A especificação define epochMilliseconds como piso. */
export function floorEpochMs(instant: Temporal.Instant): number {
  return instant.epochMilliseconds;
}

/** Menor milissegundo inteiro >= instante. */
export function ceilEpochMs(instant: Temporal.Instant): number {
  const floor = instant.epochMilliseconds;
  return instant.epochNanoseconds === BigInt(floor) * NS_PER_MS ? floor : floor + 1;
}
