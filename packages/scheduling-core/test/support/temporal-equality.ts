import { Temporal } from 'temporal-polyfill';

/**
 * Igualdade por valor para tipos Temporal em toEqual/toStrictEqual.
 * Devolve undefined quando nenhum dos lados é Temporal (o Vitest segue a comparação padrão).
 */
export function temporalEqualityTester(a: unknown, b: unknown): boolean | undefined {
  if (a instanceof Temporal.Instant || b instanceof Temporal.Instant) {
    return a instanceof Temporal.Instant && b instanceof Temporal.Instant && a.equals(b);
  }
  if (a instanceof Temporal.PlainDate || b instanceof Temporal.PlainDate) {
    return a instanceof Temporal.PlainDate && b instanceof Temporal.PlainDate && a.equals(b);
  }
  if (a instanceof Temporal.ZonedDateTime || b instanceof Temporal.ZonedDateTime) {
    return (
      a instanceof Temporal.ZonedDateTime && b instanceof Temporal.ZonedDateTime && a.equals(b)
    );
  }
  return undefined;
}
