import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { SchedulingInputError } from '../errors';
import { type Clock, fixedClock } from '../time/clock';
import { type Interval, interval } from '../time/intervals';
import {
  type AvailabilityInput,
  type AvailableSlot,
  computeAvailableSlots,
  MAX_RANGE_DAYS,
} from './compute-available-slots';
import { type ServiceDefinition, singlePhaseService } from './service';

// Exemplos = documentação viva. Datas de 2026-11 em São Paulo (sem horário de verão desde 2019).
const TUESDAY = Temporal.PlainDate.from('2026-11-03'); // isoWeekday 2
const sp = (date: string, time: string): Temporal.Instant =>
  Temporal.Instant.from(`${date}T${time}:00-03:00`);
const spTuesday = (start: string, end: string): Interval =>
  interval(sp('2026-11-03', start), sp('2026-11-03', end));

const base: AvailabilityInput = {
  timeZone: 'America/Sao_Paulo',
  from: TUESDAY,
  to: TUESDAY,
  weeklySchedule: [
    { isoWeekday: 2, start: '09:00', end: '12:00' },
    { isoWeekday: 2, start: '13:00', end: '18:00' },
  ],
  service: singlePhaseService(30),
  busy: [],
  timeOff: [],
  granularityMinutes: 30,
  minNoticeMinutes: 0,
  maxAdvanceMinutes: 60 * 24 * 60,
  clock: fixedClock('2026-11-02T12:00:00-03:00'),
};

const times = (slots: readonly AvailableSlot[]): string[] => slots.map((s) => s.localTime);
const morning = (slots: readonly AvailableSlot[]): string[] =>
  times(slots.filter((s) => s.localTime < '12:00'));
const view = (slots: readonly AvailableSlot[]) =>
  slots.map((s) => ({
    start: s.start.toString(),
    localDate: s.localDate,
    localTime: s.localTime,
    utcOffset: s.utcOffset,
  }));

const coloring: ServiceDefinition = {
  phases: [
    { kind: 'work', minutes: 30 }, // aplicação
    { kind: 'pause', minutes: 40 }, // ação do produto: profissional livre
    { kind: 'work', minutes: 30 }, // enxágue e finalização
  ],
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
};

describe('computeAvailableSlots: jornada, grade e rótulos', () => {
  it('deve oferecer horários de 30 min na grade local, sem o intervalo de almoço', () => {
    const slots = computeAvailableSlots(base);

    expect(slots).toHaveLength(16); // 6 de manhã + 10 à tarde
    expect(slots[0]).toEqual({
      start: Temporal.Instant.from('2026-11-03T12:00:00Z'),
      end: Temporal.Instant.from('2026-11-03T12:30:00Z'),
      localDate: '2026-11-03',
      localTime: '09:00',
      utcOffset: '-03:00',
    });
    expect(times(slots)).not.toContain('12:00');
    expect(times(slots).at(-1)).toBe('17:30');
  });

  it('deve alinhar a grade à meia-noite local, mesmo quando o turno começa fora dela', () => {
    const slots = computeAvailableSlots({
      ...base,
      weeklySchedule: [{ isoWeekday: 2, start: '09:05', end: '11:00' }],
      granularityMinutes: 25,
    });
    // 09:10 = 22 x 25 min desde 00:00; 10:50 + 30 min passaria do fim do turno.
    expect(times(slots)).toEqual(['09:10', '09:35', '10:00', '10:25']);
  });

  it('deve unir turnos sobrepostos antes de procurar horários', () => {
    const slots = computeAvailableSlots({
      ...base,
      weeklySchedule: [
        { isoWeekday: 2, start: '09:00', end: '10:45' },
        { isoWeekday: 2, start: '10:30', end: '12:00' },
      ],
      service: singlePhaseService(90),
    });
    expect(times(slots)).toEqual(['09:00', '09:30', '10:00', '10:30']);
  });

  it('deve aceitar 24:00 como fim de turno', () => {
    const slots = computeAvailableSlots({
      ...base,
      weeklySchedule: [{ isoWeekday: 2, start: '22:00', end: '24:00' }],
      service: singlePhaseService(60),
      granularityMinutes: 60,
    });
    expect(times(slots)).toEqual(['22:00', '23:00']);
  });

  it('deve respeitar dia da semana ISO e vigência de cada turno, em vários dias', () => {
    const slots = computeAvailableSlots({
      ...base,
      from: Temporal.PlainDate.from('2026-11-02'), // segunda
      to: Temporal.PlainDate.from('2026-11-08'), // domingo
      weeklySchedule: [
        { isoWeekday: 2, start: '09:00', end: '10:00' },
        {
          isoWeekday: 4,
          start: '14:00',
          end: '15:00',
          validFrom: Temporal.PlainDate.from('2026-11-05'),
          validUntil: Temporal.PlainDate.from('2026-11-05'),
        },
        {
          isoWeekday: 6,
          start: '08:00',
          end: '09:00',
          validFrom: Temporal.PlainDate.from('2026-11-10'), // ainda não vale
        },
        {
          isoWeekday: 7,
          start: '08:00',
          end: '09:00',
          validUntil: Temporal.PlainDate.from('2026-11-01'), // já venceu
        },
      ],
      clock: fixedClock('2026-11-01T00:00:00-03:00'),
    });
    expect(slots.map((s) => `${s.localDate} ${s.localTime}`)).toEqual([
      '2026-11-03 09:00',
      '2026-11-03 09:30',
      '2026-11-05 14:00',
      '2026-11-05 14:30',
    ]);
  });

  it('deve rotular pelo fuso da unidade, mesmo quando a data UTC é outra (Kiritimati, +14)', () => {
    const slots = computeAvailableSlots({
      ...base,
      timeZone: 'Pacific/Kiritimati',
      from: Temporal.PlainDate.from('2026-11-02'),
      to: Temporal.PlainDate.from('2026-11-02'),
      weeklySchedule: [{ isoWeekday: 1, start: '09:00', end: '10:00' }],
      clock: fixedClock('2026-10-01T00:00:00Z'),
    });
    expect(view(slots)).toEqual([
      {
        start: '2026-11-01T19:00:00Z',
        localDate: '2026-11-02',
        localTime: '09:00',
        utcOffset: '+14:00',
      },
      {
        start: '2026-11-01T19:30:00Z',
        localDate: '2026-11-02',
        localTime: '09:30',
        utcOffset: '+14:00',
      },
    ]);
  });
});

describe('computeAvailableSlots: ocupações, bloqueios, buffers e fases', () => {
  it('deve bloquear o buffer de limpeza após o atendimento', () => {
    const slots = computeAvailableSlots({
      ...base,
      service: singlePhaseService(30, { after: 10 }),
      busy: [spTuesday('10:00', '10:40')],
    });
    // 11:30 termina às 12:00; a limpeza pode passar do fim do turno (política documentada).
    expect(morning(slots)).toEqual(['09:00', '11:00', '11:30']);
  });

  it('deve bloquear o buffer de preparo antes do atendimento', () => {
    const slots = computeAvailableSlots({
      ...base,
      service: singlePhaseService(30, { before: 15 }),
      busy: [spTuesday('09:30', '09:50')],
    });
    expect(morning(slots)).toEqual(['09:00', '10:30', '11:00', '11:30']);
  });

  it('deve tratar folga/bloqueio como indisponível, com borda semiaberta', () => {
    const slots = computeAvailableSlots({ ...base, timeOff: [spTuesday('14:00', '15:00')] });
    expect(times(slots).filter((t) => t >= '13:00')).toEqual([
      '13:00',
      '13:30',
      '15:00',
      '15:30',
      '16:00',
      '16:30',
      '17:00',
      '17:30',
    ]);
  });

  it('deve deixar o profissional livre durante a pausa de um serviço multietapa', () => {
    expect(morning(computeAvailableSlots({ ...base, service: coloring }))).toEqual([
      '09:00',
      '09:30',
      '10:00',
    ]);
    // Outro cliente atendido durante a pausa da coloração das 09:00 não a impede.
    const withBusyInPause = computeAvailableSlots({
      ...base,
      service: coloring,
      busy: [spTuesday('09:30', '10:10')],
    });
    expect(morning(withBusyInPause)).toEqual(['09:00']);
  });

  it('deve recusar o horário quando a ocupação cai numa fase de trabalho', () => {
    const slots = computeAvailableSlots({
      ...base,
      service: coloring,
      busy: [spTuesday('09:20', '09:40')],
    });
    expect(morning(slots)).toEqual(['10:00']);
  });

  it('deve ignorar ocupação vazia (início = fim)', () => {
    const slots = computeAvailableSlots({ ...base, busy: [spTuesday('10:00', '10:00')] });
    expect(slots).toHaveLength(16);
  });

  it('deve comparar instantes com precisão de nanossegundo', () => {
    const ninePm = sp('2026-11-03', '09:00');
    const touching = computeAvailableSlots({
      ...base,
      busy: [interval(sp('2026-11-03', '08:00'), ninePm)],
    });
    expect(times(touching)[0]).toBe('09:00');

    const oneNanoLate = computeAvailableSlots({
      ...base,
      busy: [interval(sp('2026-11-03', '08:00'), ninePm.add({ nanoseconds: 1 }))],
    });
    expect(times(oneNanoLate)[0]).toBe('09:30');
  });
});

describe('computeAvailableSlots: antecedência e horizonte (relativos ao Clock)', () => {
  it('deve respeitar a antecedência mínima', () => {
    const slots = computeAvailableSlots({
      ...base,
      clock: fixedClock('2026-11-03T10:50:00-03:00'),
      minNoticeMinutes: 60,
    });
    expect(times(slots)[0]).toBe('13:00');
  });

  it('deve incluir o horário que começa exatamente no limite do horizonte', () => {
    const slots = computeAvailableSlots({
      ...base,
      clock: fixedClock('2026-11-03T09:00:00-03:00'),
      maxAdvanceMinutes: 120,
    });
    expect(times(slots)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
  });

  it('deve oferecer só o instante exato quando antecedência = horizonte', () => {
    const slots = computeAvailableSlots({
      ...base,
      clock: fixedClock('2026-11-03T08:00:00-03:00'),
      minNoticeMinutes: 60,
      maxAdvanceMinutes: 60,
    });
    expect(times(slots)).toEqual(['09:00']);
  });

  it('não deve oferecer nada quando o horizonte é menor que a antecedência', () => {
    const slots = computeAvailableSlots({ ...base, minNoticeMinutes: 120, maxAdvanceMinutes: 60 });
    expect(slots).toEqual([]);
  });

  it('deve comparar o agora com precisão de nanossegundo', () => {
    const justBefore = sp('2026-11-03', '09:00').subtract({ nanoseconds: 1 });
    expect(times(computeAvailableSlots({ ...base, clock: fixedClock(justBefore) }))[0]).toBe(
      '09:00',
    );
    const justAfter = sp('2026-11-03', '09:00').add({ nanoseconds: 1 });
    expect(times(computeAvailableSlots({ ...base, clock: fixedClock(justAfter) }))[0]).toBe(
      '09:30',
    );
  });

  it('deve ler o relógio uma única vez por cálculo', () => {
    let reads = 0;
    const countingClock: Clock = {
      now: () => {
        reads += 1;
        return Temporal.Instant.from('2026-11-02T15:00:00Z');
      },
    };
    computeAvailableSlots({ ...base, clock: countingClock });
    expect(reads).toBe(1);
  });
});

describe('computeAvailableSlots: horário de verão e fusos', () => {
  it('deve tratar a meia-noite inexistente (início do horário de verão de 2018 em São Paulo)', () => {
    const slots = computeAvailableSlots({
      ...base,
      from: Temporal.PlainDate.from('2018-11-04'),
      to: Temporal.PlainDate.from('2018-11-04'),
      weeklySchedule: [{ isoWeekday: 7, start: '00:00', end: '02:00' }],
      clock: fixedClock('2018-11-01T00:00:00Z'),
    });
    // 00:00 pulou para 01:00 (-02): sobra 1 h real de jornada.
    expect(view(slots)).toEqual([
      {
        start: '2018-11-04T03:00:00Z',
        localDate: '2018-11-04',
        localTime: '01:00',
        utcOffset: '-02:00',
      },
      {
        start: '2018-11-04T03:30:00Z',
        localDate: '2018-11-04',
        localTime: '01:30',
        utcOffset: '-02:00',
      },
    ]);
  });

  it('deve pular os rótulos inexistentes na lacuna (Nova York, 2026-03-08)', () => {
    const slots = computeAvailableSlots({
      ...base,
      timeZone: 'America/New_York',
      from: Temporal.PlainDate.from('2026-03-08'),
      to: Temporal.PlainDate.from('2026-03-08'),
      weeklySchedule: [{ isoWeekday: 7, start: '01:00', end: '04:00' }],
      clock: fixedClock('2026-03-01T00:00:00Z'),
    });
    expect(view(slots)).toEqual([
      {
        start: '2026-03-08T06:00:00Z',
        localDate: '2026-03-08',
        localTime: '01:00',
        utcOffset: '-05:00',
      },
      {
        start: '2026-03-08T06:30:00Z',
        localDate: '2026-03-08',
        localTime: '01:30',
        utcOffset: '-05:00',
      },
      {
        start: '2026-03-08T07:00:00Z',
        localDate: '2026-03-08',
        localTime: '03:00',
        utcOffset: '-04:00',
      },
      {
        start: '2026-03-08T07:30:00Z',
        localDate: '2026-03-08',
        localTime: '03:30',
        utcOffset: '-04:00',
      },
    ]);
  });

  it('deve oferecer as duas ocorrências da hora repetida, distinguidas pelo offset', () => {
    const slots = computeAvailableSlots({
      ...base,
      timeZone: 'America/New_York',
      from: Temporal.PlainDate.from('2026-11-01'),
      to: Temporal.PlainDate.from('2026-11-01'),
      weeklySchedule: [{ isoWeekday: 7, start: '00:30', end: '03:00' }],
      service: singlePhaseService(60),
      clock: fixedClock('2026-10-01T00:00:00Z'),
    });
    expect(slots.map((s) => `${s.start.toString()} ${s.localTime}${s.utcOffset}`)).toEqual([
      '2026-11-01T04:30:00Z 00:30-04:00',
      '2026-11-01T05:00:00Z 01:00-04:00',
      '2026-11-01T05:30:00Z 01:30-04:00',
      '2026-11-01T06:00:00Z 01:00-05:00',
      '2026-11-01T06:30:00Z 01:30-05:00',
      '2026-11-01T07:00:00Z 02:00-05:00',
    ]);
  });

  it('deve manter a grade no relógio local com horário de verão de 30 min (Lord Howe)', () => {
    const slots = computeAvailableSlots({
      ...base,
      timeZone: 'Australia/Lord_Howe',
      from: Temporal.PlainDate.from('2026-10-04'),
      to: Temporal.PlainDate.from('2026-10-04'),
      weeklySchedule: [{ isoWeekday: 7, start: '00:00', end: '06:00' }],
      service: singlePhaseService(60),
      granularityMinutes: 60,
      clock: fixedClock('2026-09-01T00:00:00Z'),
    });
    expect(slots.map((s) => `${s.localTime}${s.utcOffset}`)).toEqual([
      '00:00+10:30',
      '01:00+10:30',
      '03:00+11:00',
      '04:00+11:00',
      '05:00+11:00',
    ]);
  });

  it('não deve oferecer nada num dia local que não existiu (Pacific/Apia, 2011-12-30)', () => {
    const slots = computeAvailableSlots({
      ...base,
      timeZone: 'Pacific/Apia',
      from: Temporal.PlainDate.from('2011-12-29'),
      to: Temporal.PlainDate.from('2011-12-31'),
      weeklySchedule: [
        { isoWeekday: 5, start: '09:00', end: '18:00' },
        { isoWeekday: 6, start: '09:00', end: '10:00' },
      ],
      clock: fixedClock('2011-12-01T00:00:00Z'),
    });
    expect(slots.map((s) => `${s.localDate} ${s.localTime}${s.utcOffset}`)).toEqual([
      '2011-12-31 09:00+14:00',
      '2011-12-31 09:30+14:00',
    ]);
  });
});

describe('computeAvailableSlots: pureza e validação de entrada', () => {
  it('não deve alterar a entrada (funciona com entrada congelada em profundidade)', () => {
    const frozen = deepFreeze({
      ...base,
      busy: [spTuesday('10:00', '10:30')],
      timeOff: [spTuesday('15:00', '16:00')],
    });
    const first = computeAvailableSlots(frozen);
    expect(computeAvailableSlots(frozen)).toEqual(first);
  });

  const invalid: [string, Partial<AvailabilityInput>][] = [
    ['fuso como offset fixo', { timeZone: '-03:00' }],
    ['fuso desconhecido', { timeZone: 'Mars/Olympus_Mons' }],
    ['from depois de to', { from: TUESDAY.add({ days: 1 }), to: TUESDAY }],
    ['intervalo de datas longo demais', { to: TUESDAY.add({ days: MAX_RANGE_DAYS }) }],
    ['calendário não ISO', { from: TUESDAY.withCalendar('gregory') }],
    ['hora mal formatada', { weeklySchedule: [{ isoWeekday: 2, start: '9:00', end: '12:00' }] }],
    ['24:00 como início', { weeklySchedule: [{ isoWeekday: 2, start: '24:00', end: '24:00' }] }],
    ['fim igual ao início', { weeklySchedule: [{ isoWeekday: 2, start: '10:00', end: '10:00' }] }],
    ['dia da semana 0', { weeklySchedule: [{ isoWeekday: 0 as 1, start: '09:00', end: '10:00' }] }],
    ['dia da semana 8', { weeklySchedule: [{ isoWeekday: 8 as 1, start: '09:00', end: '10:00' }] }],
    [
      'vigência invertida',
      {
        weeklySchedule: [
          {
            isoWeekday: 2,
            start: '09:00',
            end: '10:00',
            validFrom: TUESDAY,
            validUntil: TUESDAY.subtract({ days: 1 }),
          },
        ],
      },
    ],
    [
      'vigência em calendário não ISO',
      {
        weeklySchedule: [
          {
            isoWeekday: 2,
            start: '09:00',
            end: '10:00',
            validFrom: TUESDAY.withCalendar('gregory'),
          },
        ],
      },
    ],
    ['granularidade zero', { granularityMinutes: 0 }],
    ['granularidade fracionária', { granularityMinutes: 2.5 }],
    ['granularidade maior que um dia', { granularityMinutes: 1441 }],
    ['antecedência negativa', { minNoticeMinutes: -1 }],
    ['horizonte fracionário', { maxAdvanceMinutes: 1.5 }],
    [
      'ocupação invertida',
      { busy: [{ start: sp('2026-11-03', '11:00'), end: sp('2026-11-03', '10:00') }] },
    ],
    [
      'bloqueio invertido',
      { timeOff: [{ start: sp('2026-11-03', '11:00'), end: sp('2026-11-03', '10:00') }] },
    ],
    [
      'serviço sem trabalho',
      { service: { ...coloring, phases: [{ kind: 'pause', minutes: 30 }] } },
    ],
  ];

  it.each(invalid)('deve rejeitar entrada inválida: %s', (_label, override) => {
    expect(() => computeAvailableSlots({ ...base, ...override })).toThrow(SchedulingInputError);
  });

  it('deve indicar o campo inválido no erro', () => {
    expect(() =>
      computeAvailableSlots({
        ...base,
        weeklySchedule: [
          { isoWeekday: 2, start: '09:00', end: '10:00' },
          { isoWeekday: 2, start: '13:00', end: '1300' },
        ],
      }),
    ).toThrow(/weeklySchedule\[1\]\.end/);
  });

  it('deve aceitar o maior intervalo de datas permitido', () => {
    const slots = computeAvailableSlots({
      ...base,
      to: TUESDAY.add({ days: MAX_RANGE_DAYS - 1 }),
    });
    expect(slots.length).toBeGreaterThan(16);
  });
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}
