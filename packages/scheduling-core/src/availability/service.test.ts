import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { SchedulingInputError } from '../errors';
import {
  OCCUPANCY_KINDS,
  serviceFootprint,
  singlePhaseService,
  staffBusyIntervals,
  staffOccupancySegments,
} from './service';

describe('singlePhaseService', () => {
  it('deve montar um serviço de fase única com buffers opcionais', () => {
    expect(singlePhaseService(30)).toEqual({
      phases: [{ kind: 'work', minutes: 30 }],
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    });
    expect(singlePhaseService(45, { before: 5, after: 10 })).toEqual({
      phases: [{ kind: 'work', minutes: 45 }],
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 10,
    });
  });
});

describe('serviceFootprint', () => {
  it('deve unir trabalho e buffers contíguos num único trecho ocupado', () => {
    expect(serviceFootprint(singlePhaseService(30, { before: 5, after: 10 }))).toEqual({
      durationMinutes: 30,
      staffBusy: [{ startMinute: -5, endMinute: 40 }],
    });
  });

  it('deve liberar o profissional durante a pausa (coloração: aplicação, ação, finalização)', () => {
    const coloring = {
      phases: [
        { kind: 'work', minutes: 30 },
        { kind: 'pause', minutes: 40 },
        { kind: 'work', minutes: 30 },
      ],
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 10,
    } as const;
    expect(serviceFootprint(coloring)).toEqual({
      durationMinutes: 100,
      staffBusy: [
        { startMinute: 0, endMinute: 30 },
        { startMinute: 70, endMinute: 110 },
      ],
    });
  });

  it('deve manter o buffer de preparo separado quando o serviço começa com pausa', () => {
    const service = {
      phases: [
        { kind: 'pause', minutes: 10 },
        { kind: 'work', minutes: 20 },
      ],
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 0,
    } as const;
    expect(serviceFootprint(service).staffBusy).toEqual([
      { startMinute: -5, endMinute: 0 },
      { startMinute: 10, endMinute: 30 },
    ]);
  });

  it('deve unir fases de trabalho consecutivas', () => {
    const service = {
      phases: [
        { kind: 'work', minutes: 10 },
        { kind: 'work', minutes: 20 },
      ],
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    } as const;
    expect(serviceFootprint(service).staffBusy).toEqual([{ startMinute: 0, endMinute: 30 }]);
  });

  it.each([
    ['sem fases', { phases: [], bufferBeforeMinutes: 0, bufferAfterMinutes: 0 }],
    [
      'só pausa',
      { phases: [{ kind: 'pause', minutes: 30 }], bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
    ],
    [
      'fase de 0 min',
      { phases: [{ kind: 'work', minutes: 0 }], bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
    ],
    [
      'minutos fracionários',
      { phases: [{ kind: 'work', minutes: 7.5 }], bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
    ],
    [
      'buffer negativo',
      { phases: [{ kind: 'work', minutes: 30 }], bufferBeforeMinutes: -5, bufferAfterMinutes: 0 },
    ],
    [
      'mais de 24 h',
      { phases: [{ kind: 'work', minutes: 1441 }], bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
    ],
    [
      'fases somando mais de 24 h',
      {
        phases: [
          { kind: 'work', minutes: 720 },
          { kind: 'pause', minutes: 721 },
        ],
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
      },
    ],
    [
      'tipo de fase desconhecido',
      { phases: [{ kind: 'nap', minutes: 30 }], bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
    ],
  ])('deve rejeitar serviço inválido: %s', (_label, service) => {
    // @ts-expect-error -- entradas deliberadamente inválidas, como chegariam de dados externos
    expect(() => serviceFootprint(service)).toThrow(SchedulingInputError);
  });

  it('deve aceitar duração visível de exatamente 24 h, em uma fase ou somando fases', () => {
    expect(serviceFootprint(singlePhaseService(1440))).toEqual({
      durationMinutes: 1440,
      staffBusy: [{ startMinute: 0, endMinute: 1440 }],
    });
    const split = {
      phases: [
        { kind: 'work', minutes: 720 },
        { kind: 'pause', minutes: 720 },
      ],
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    } as const;
    expect(serviceFootprint(split)).toEqual({
      durationMinutes: 1440,
      staffBusy: [{ startMinute: 0, endMinute: 720 }],
    });
  });

  it('deve aceitar buffers de até 24 h', () => {
    expect(serviceFootprint(singlePhaseService(30, { before: 1440, after: 1440 }))).toEqual({
      durationMinutes: 30,
      staffBusy: [{ startMinute: -1440, endMinute: 1470 }],
    });
  });

  it.each([
    ['service.bufferBeforeMinutes', singlePhaseService(30, { before: 1441 })],
    ['service.bufferAfterMinutes', singlePhaseService(30, { after: 1441 })],
    ['service.phases[0].minutes', singlePhaseService(1441)],
    [
      'service.phases',
      {
        phases: [
          { kind: 'work', minutes: 1 },
          { kind: 'pause', minutes: 1440 },
        ],
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
      } as const,
    ],
  ])('deve recusar acima de 24 h apontando o campo %s', (field, service) => {
    let caught: unknown;
    try {
      serviceFootprint(service);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchedulingInputError);
    expect(caught).toHaveProperty('field', field);
  });
});

describe('staffOccupancySegments', () => {
  const start = Temporal.Instant.from('2026-11-03T13:00:00Z');
  const rows = (service: Parameters<typeof staffOccupancySegments>[1]) =>
    staffOccupancySegments(start, service).map(
      (x) => `${x.kind} ${x.start.toString()}/${x.end.toString()}`,
    );

  it('deve conhecer exatamente os tipos de ocupação do banco (occupancies.kind)', () => {
    expect(OCCUPANCY_KINDS).toEqual(['service', 'buffer']);
    expect(Object.isFrozen(OCCUPANCY_KINDS)).toBe(true);
  });

  it('deve devolver uma ocupação por buffer e por fase de trabalho, sem unir, com o tipo', () => {
    const coloring = {
      phases: [
        { kind: 'work', minutes: 30 },
        { kind: 'pause', minutes: 40 },
        { kind: 'work', minutes: 30 },
      ],
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 15,
    } as const;
    expect(rows(coloring)).toEqual([
      'buffer 2026-11-03T12:50:00Z/2026-11-03T13:00:00Z',
      'service 2026-11-03T13:00:00Z/2026-11-03T13:30:00Z',
      'service 2026-11-03T14:10:00Z/2026-11-03T14:40:00Z',
      'buffer 2026-11-03T14:40:00Z/2026-11-03T14:55:00Z',
    ]);
  });

  it('deve gravar uma linha por fase de trabalho, mesmo quando as fases se encostam', () => {
    const service = {
      phases: [
        { kind: 'work', minutes: 10 },
        { kind: 'work', minutes: 20 },
      ],
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    } as const;
    expect(rows(service)).toEqual([
      'service 2026-11-03T13:00:00Z/2026-11-03T13:10:00Z',
      'service 2026-11-03T13:10:00Z/2026-11-03T13:30:00Z',
    ]);
  });

  it('não deve gerar linha para buffer zero nem para pausa', () => {
    expect(rows(singlePhaseService(30))).toEqual([
      'service 2026-11-03T13:00:00Z/2026-11-03T13:30:00Z',
    ]);
  });

  it('deve validar o serviço como serviceFootprint', () => {
    expect(() => staffOccupancySegments(start, singlePhaseService(0))).toThrow(
      SchedulingInputError,
    );
  });
});

describe('staffBusyIntervals', () => {
  it('deve devolver as ocupações absolutas do profissional para um início escolhido', () => {
    const start = Temporal.Instant.from('2026-11-03T13:00:00Z');
    const coloring = {
      phases: [
        { kind: 'work', minutes: 30 },
        { kind: 'pause', minutes: 40 },
        { kind: 'work', minutes: 30 },
      ],
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 0,
    } as const;
    const busy = staffBusyIntervals(start, coloring).map(
      (x) => `${x.start.toString()}/${x.end.toString()}`,
    );
    expect(busy).toEqual([
      '2026-11-03T12:50:00Z/2026-11-03T13:30:00Z',
      '2026-11-03T14:10:00Z/2026-11-03T14:40:00Z',
    ]);
  });
});
