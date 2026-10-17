import { Temporal } from 'temporal-polyfill';
import { SchedulingInputError } from '../errors';

/**
 * Fonte de tempo injetada. O domínio nunca lê o relógio da máquina diretamente
 * (regra de lint): quem precisa de "agora" recebe um Clock por parâmetro.
 */
export interface Clock {
  /** Instante atual na linha do tempo absoluta (UTC). */
  now(): Temporal.Instant;
}

/**
 * Relógio real, para produção. Segue o relógio do sistema (NTP pode ajustá-lo, então não
 * é estritamente monotônico entre processos). É o único ponto do pacote que o lê.
 */
export const systemClock: Clock = Object.freeze({
  // eslint-disable-next-line no-restricted-syntax, no-restricted-properties -- único ponto autorizado a ler o relógio real; o resto do domínio recebe Clock por injeção.
  now: (): Temporal.Instant => Temporal.Now.instant(),
});

/**
 * Relógio parado num instante fixo, para testes e cálculos reproduzíveis.
 * Texto precisa ser ISO 8601 com offset ou "Z" (sem offset dependeria do fuso da máquina).
 */
export function fixedClock(at: Temporal.Instant | string): Clock {
  const instant = typeof at === 'string' ? parseInstant(at) : at;
  return Object.freeze({ now: (): Temporal.Instant => instant });
}

function parseInstant(text: string): Temporal.Instant {
  try {
    return Temporal.Instant.from(text);
  } catch (cause) {
    throw new SchedulingInputError(
      'clock',
      `instante inválido "${text}": use ISO 8601 com offset ou Z`,
      { cause },
    );
  }
}
