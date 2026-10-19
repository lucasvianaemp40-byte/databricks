import * as fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';

/**
 * Fusos dos testes de propriedade: os brasileiros mais os que têm horário de verão ou
 * offset incomum. Blindam o motor contra a volta do horário de verão no Brasil e contra
 * dependência acidental do fuso da máquina.
 */
export const ZONES = [
  'America/Sao_Paulo', // horário de verão até 2019 (lacuna à meia-noite)
  'America/Manaus', // -04
  'America/Noronha', // -02
  'America/Rio_Branco', // -05
  'America/New_York', // horário de verão às 02:00
  'America/Santiago', // horário de verão à meia-noite
  'Europe/Lisbon',
  'Europe/London',
  'Australia/Lord_Howe', // horário de verão de 30 min
  'Pacific/Chatham', // +12:45 / +13:45
  'Asia/Kathmandu', // +05:45
  'Pacific/Kiritimati', // +14 (data local à frente da UTC)
  'Pacific/Apia', // pulou o dia 2011-12-30 inteiro
  'Etc/UTC', // o banco recusa 'UTC' (sem "/")
] as const;

/** Fusos com offset constante de 2020 em diante (base da propriedade de translação). */
export const FIXED_OFFSET_ZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Noronha',
  'America/Rio_Branco',
  'Asia/Kathmandu',
  'Pacific/Kiritimati',
  'Etc/UTC',
] as const;

const FIRST_RANDOM_DATE = Temporal.PlainDate.from('2018-01-01');
const FIRST_FIXED_OFFSET_DATE = Temporal.PlainDate.from('2020-01-01');
const ELEVEN_YEARS_IN_DAYS = 11 * 366;

/**
 * Datas locais vizinhas de cada transição real do tzdata (2010 a 2030) num fuso: o dia
 * antes da transição e o dia dela. Calculado com Temporal, não digitado à mão.
 */
export function transitionDates(timeZone: string): readonly string[] {
  const dates = new Set<string>();
  const last = Temporal.Instant.from('2031-01-01T00:00:00Z');
  let cursor: Temporal.ZonedDateTime | null =
    Temporal.Instant.from('2010-01-01T00:00:00Z').toZonedDateTimeISO(timeZone);
  for (;;) {
    cursor = cursor.getTimeZoneTransition('next');
    if (cursor === null || Temporal.Instant.compare(cursor.toInstant(), last) >= 0) break;
    dates.add(cursor.subtract({ nanoseconds: 1 }).toPlainDate().toString());
    dates.add(cursor.toPlainDate().toString());
  }
  return [...dates];
}

/** Pares (fuso, data de transição) de todos os fusos com horário de verão no período. */
const TRANSITION_PAIRS = ZONES.flatMap((timeZone) =>
  transitionDates(timeZone).map((date) => ({ timeZone, date })),
);

const randomDateArb: fc.Arbitrary<Temporal.PlainDate> = fc
  .integer({ min: 0, max: 13 * 366 })
  .map((days) => FIRST_RANDOM_DATE.add({ days }));

export interface ZoneAndDate {
  readonly timeZone: string;
  readonly from: Temporal.PlainDate;
}

/** Fuso + primeira data: na maioria das vezes perto de uma transição real daquele fuso. */
export function zoneAndDateArb(zones: readonly string[] = ZONES): fc.Arbitrary<ZoneAndDate> {
  const pairs = TRANSITION_PAIRS.filter((pair) => zones.includes(pair.timeZone));
  const anyDate = fc.record({ timeZone: fc.constantFrom(...zones), from: randomDateArb });
  if (pairs.length === 0) return anyDate;
  return fc.oneof(
    {
      weight: 3,
      arbitrary: fc
        .constantFrom(...pairs)
        .map(({ timeZone, date }) => ({ timeZone, from: Temporal.PlainDate.from(date) })),
    },
    { weight: 2, arbitrary: anyDate },
  );
}

/**
 * Fusos em que uma transição DEPOIS da meia-noite devolveu o relógio à véspera: o dia D
 * começa e o relógio volta a marcar D-1 (St. John's e Goose Bay às 00:01 até 2010, Moncton
 * até 2006, Antarctica/Casey em 2010-03-05). Ficam fora de {@link ZONES} de propósito: o
 * quadro do dia local inclui esses instantes da véspera, então a propriedade "todo instante
 * do quadro marca a data D" (local-day.prop.test.ts) não vale neles.
 */
export const BACKWARD_PAST_MIDNIGHT_ZONES = [
  'America/St_Johns',
  'America/Goose_Bay',
  'America/Moncton',
  'Antarctica/Casey',
] as const;

/**
 * Datas D (e a véspera D-1) em que o relógio voltou para D-1 depois de D começar, entre 1987
 * e 2010. Calculado com Temporal a partir do tzdata, não digitado à mão.
 */
export function backwardPastMidnightDates(timeZone: string): readonly string[] {
  const dates = new Set<string>();
  const last = Temporal.Instant.from('2011-01-01T00:00:00Z');
  let cursor: Temporal.ZonedDateTime | null =
    Temporal.Instant.from('1987-01-01T00:00:00Z').toZonedDateTimeISO(timeZone);
  for (;;) {
    cursor = cursor.getTimeZoneTransition('next');
    if (cursor === null || Temporal.Instant.compare(cursor.toInstant(), last) >= 0) break;
    const before = cursor.subtract({ nanoseconds: 1 }).toPlainDate();
    if (Temporal.PlainDate.compare(cursor.toPlainDate(), before) < 0) {
      dates.add(before.subtract({ days: 1 }).toString());
      dates.add(before.toString());
    }
  }
  return [...dates];
}

const BACKWARD_PAST_MIDNIGHT_PAIRS = BACKWARD_PAST_MIDNIGHT_ZONES.flatMap((timeZone) =>
  backwardPastMidnightDates(timeZone).map((date) => ({ timeZone, date })),
);

/** Fuso + data em que o relógio voltou para a véspera (ou a véspera desse dia). */
export function backwardPastMidnightZoneAndDateArb(): fc.Arbitrary<ZoneAndDate> {
  if (BACKWARD_PAST_MIDNIGHT_PAIRS.length === 0) {
    // Falha alta: sem esses dias no tzdata do runtime, as propriedades deixariam de testar o caso.
    throw new Error('tzdata sem transição que volte o relógio para a véspera (1987-2010)');
  }
  return fc
    .constantFrom(...BACKWARD_PAST_MIDNIGHT_PAIRS)
    .map(({ timeZone, date }) => ({ timeZone, from: Temporal.PlainDate.from(date) }));
}

/** Fusos de offset fixo com datas de 2020 a 2030 (sem transição alguma). */
export const fixedOffsetZoneAndDateArb: fc.Arbitrary<ZoneAndDate> = fc.record({
  timeZone: fc.constantFrom(...FIXED_OFFSET_ZONES),
  from: fc
    .integer({ min: 0, max: ELEVEN_YEARS_IN_DAYS - 7 })
    .map((days) => FIRST_FIXED_OFFSET_DATE.add({ days })),
});

/** Ruído abaixo do minuto: na maioria das vezes zero, às vezes até nanossegundos. */
export const subMinuteNoiseNsArb: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 3, arbitrary: fc.constant(0n) },
  { weight: 1, arbitrary: fc.bigInt({ min: 1n, max: 59_999_999_999n }) },
);
