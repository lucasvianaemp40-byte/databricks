// Fixture de `semgrep --test` para domain-clock. Código proibido no domínio de propósito.
import { Temporal } from 'temporal-polyfill';

interface Clock {
  now(): Temporal.Instant;
}

export function forbidden(): unknown[] {
  return [
    // ruleid: domain-clock
    Date.now(),
    // ruleid: domain-clock
    new Date(),
    // ruleid: domain-clock
    Date(),
    // ruleid: domain-clock
    Temporal.Now.instant(),
    // ruleid: domain-clock
    Temporal.Now.plainDateISO('America/Sao_Paulo'),
    // ruleid: domain-clock
    Math.random(),
    // ruleid: domain-clock
    performance.now(),
    // ruleid: domain-clock
    crypto.randomUUID(),
  ];
}

export function allowed(clock: Clock, epochMs: number): unknown[] {
  return [
    // ok: domain-clock
    clock.now(),
    // ok: domain-clock
    new Date(epochMs),
    // ok: domain-clock
    Temporal.Instant.fromEpochMilliseconds(epochMs),
  ];
}
