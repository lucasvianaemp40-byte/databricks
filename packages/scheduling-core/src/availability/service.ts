import type { Temporal } from 'temporal-polyfill';
import { assertIntegerInRange, SchedulingInputError } from '../errors';
import type { Interval } from '../time/intervals';
import { MINUTES_PER_DAY } from '../time/wall-time';

/** 'work' ocupa o profissional; 'pause' (ação do produto) deixa-o livre, cliente na cadeira. */
export type ServicePhaseKind = 'work' | 'pause';

export interface ServicePhase {
  readonly kind: ServicePhaseKind;
  /** Duração em minutos inteiros (> 0). */
  readonly minutes: number;
}

/**
 * O que importa de um serviço para a agenda. A duração vista pelo cliente é a soma das
 * fases. Buffers (preparo antes, limpeza depois) ocupam o profissional mas não aparecem
 * para o cliente. Sem fases cadastradas no banco = uma fase 'work' com a duração do serviço.
 */
export interface ServiceDefinition {
  readonly phases: readonly ServicePhase[];
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
}

/** Trecho [startMinute, endMinute) relativo ao início visível do atendimento. */
export interface MinuteRange {
  readonly startMinute: number;
  readonly endMinute: number;
}

/** "Pegada" do serviço na agenda do profissional, relativa ao início visível. */
export interface ServiceFootprint {
  /** Duração vista pelo cliente (soma das fases, inclui pausas). */
  readonly durationMinutes: number;
  /** Trechos em que o profissional fica ocupado (buffers + fases de trabalho), unidos. */
  readonly staffBusy: readonly MinuteRange[];
}

const PHASE_KINDS: ReadonlySet<string> = new Set<ServicePhaseKind>(['work', 'pause']);

/** Serviço de fase única (o caso comum: corte, barba, manicure). */
export function singlePhaseService(
  durationMinutes: number,
  buffers: { readonly before?: number; readonly after?: number } = {},
): ServiceDefinition {
  return {
    phases: [{ kind: 'work', minutes: durationMinutes }],
    bufferBeforeMinutes: buffers.before ?? 0,
    bufferAfterMinutes: buffers.after ?? 0,
  };
}

/**
 * Valida o serviço e calcula a pegada. Exige ao menos uma fase de trabalho, minutos
 * inteiros positivos e duração visível de no máximo 24 h.
 */
export function serviceFootprint(service: ServiceDefinition, field = 'service'): ServiceFootprint {
  const { phases, bufferBeforeMinutes, bufferAfterMinutes } = service;
  assertIntegerInRange(`${field}.bufferBeforeMinutes`, bufferBeforeMinutes, 0, MINUTES_PER_DAY);
  assertIntegerInRange(`${field}.bufferAfterMinutes`, bufferAfterMinutes, 0, MINUTES_PER_DAY);
  if (phases.length === 0) {
    throw new SchedulingInputError(`${field}.phases`, 'o serviço precisa de ao menos uma fase');
  }

  const pieces: MinuteRange[] = [];
  if (bufferBeforeMinutes > 0) pieces.push({ startMinute: -bufferBeforeMinutes, endMinute: 0 });
  let offset = 0;
  for (const [index, phase] of phases.entries()) {
    const at = `${field}.phases[${index}]`;
    if (!PHASE_KINDS.has(phase.kind)) {
      throw new SchedulingInputError(`${at}.kind`, `tipo de fase desconhecido "${phase.kind}"`);
    }
    assertIntegerInRange(`${at}.minutes`, phase.minutes, 1, MINUTES_PER_DAY);
    if (phase.kind === 'work') {
      pieces.push({ startMinute: offset, endMinute: offset + phase.minutes });
    }
    offset += phase.minutes;
  }
  if (!phases.some((phase) => phase.kind === 'work')) {
    throw new SchedulingInputError(
      `${field}.phases`,
      'o serviço precisa de ao menos uma fase de trabalho',
    );
  }
  if (offset > MINUTES_PER_DAY) {
    throw new SchedulingInputError(
      `${field}.phases`,
      `duração total de ${offset} min passa de 24 h`,
    );
  }
  if (bufferAfterMinutes > 0) {
    pieces.push({ startMinute: offset, endMinute: offset + bufferAfterMinutes });
  }
  return { durationMinutes: offset, staffBusy: joinAdjacent(pieces) };
}

/**
 * Alocações absolutas do profissional para um atendimento que começa em `start`
 * (o que a reserva grava em `allocations`, uma linha por trecho ocupado).
 */
export function staffBusyIntervals(
  start: Temporal.Instant,
  service: ServiceDefinition,
): readonly Interval[] {
  return serviceFootprint(service).staffBusy.map((range) => ({
    start: start.add({ minutes: range.startMinute }),
    end: start.add({ minutes: range.endMinute }),
  }));
}

/** Une trechos já ordenados que se tocam ou se sobrepõem. */
function joinAdjacent(pieces: readonly MinuteRange[]): readonly MinuteRange[] {
  const joined: MinuteRange[] = [];
  for (const piece of pieces) {
    const last = joined.at(-1);
    if (last !== undefined && piece.startMinute <= last.endMinute) {
      joined[joined.length - 1] = {
        startMinute: last.startMinute,
        endMinute: Math.max(last.endMinute, piece.endMinute),
      };
    } else {
      joined.push(piece);
    }
  }
  return joined;
}
