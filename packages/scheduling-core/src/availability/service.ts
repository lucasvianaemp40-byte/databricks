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
 * Tipos de ocupação que a reserva grava (`occupancies.kind` do @salon/db): `service` para
 * cada fase de trabalho, `buffer` para preparo e limpeza. Mantenha em sincronia com o banco:
 * os testes de paridade do @salon/db reprovam a divergência (src/occupancy-kinds-sync.test.ts
 * contra schema e migrações; "paridade com o core: o banco aceita em occupancies.kind
 * exatamente OCCUPANCY_KINDS", em test/integration/constraints.int.test.ts, contra o catálogo).
 */
export const OCCUPANCY_KINDS = Object.freeze(['service', 'buffer'] as const);

export type OccupancyKind = (typeof OCCUPANCY_KINDS)[number];

/** Uma linha de `occupancies`: trecho absoluto em que o profissional fica ocupado, com o tipo. */
export interface OccupancySegment extends Interval {
  readonly kind: OccupancyKind;
}

interface LabeledMinuteRange extends MinuteRange {
  readonly kind: OccupancyKind;
}

interface ValidatedService {
  readonly durationMinutes: number;
  /** Buffer de preparo, cada fase de trabalho e buffer de limpeza, em ordem e SEM unir. */
  readonly pieces: readonly LabeledMinuteRange[];
}

/**
 * Valida o serviço e calcula a pegada. Exige ao menos uma fase de trabalho, minutos
 * inteiros positivos e duração visível de no máximo 24 h.
 */
export function serviceFootprint(service: ServiceDefinition, field = 'service'): ServiceFootprint {
  const { durationMinutes, pieces } = validateService(service, field);
  return { durationMinutes, staffBusy: joinAdjacent(pieces) };
}

/**
 * Trechos ocupados do profissional para um atendimento que começa em `start`, UNIDOS quando
 * se tocam: o que o motor de disponibilidade testa contra ocupações e bloqueios. Para gravar
 * a reserva (uma linha por fase e por buffer, com `kind`), use {@link staffOccupancySegments}.
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

/**
 * Ocupações que a reserva grava em `occupancies` para um atendimento que começa em `start`:
 * o buffer de preparo (`buffer`), cada fase de trabalho (`service`) e o buffer de limpeza
 * (`buffer`), em ordem cronológica e SEM unir trechos encostados. Pausas e buffers de 0 min
 * não geram linha. A união dos trechos é exatamente {@link staffBusyIntervals}.
 */
export function staffOccupancySegments(
  start: Temporal.Instant,
  service: ServiceDefinition,
): readonly OccupancySegment[] {
  return validateService(service, 'service').pieces.map((piece) => ({
    kind: piece.kind,
    start: start.add({ minutes: piece.startMinute }),
    end: start.add({ minutes: piece.endMinute }),
  }));
}

function validateService(service: ServiceDefinition, field: string): ValidatedService {
  const { phases, bufferBeforeMinutes, bufferAfterMinutes } = service;
  assertIntegerInRange(`${field}.bufferBeforeMinutes`, bufferBeforeMinutes, 0, MINUTES_PER_DAY);
  assertIntegerInRange(`${field}.bufferAfterMinutes`, bufferAfterMinutes, 0, MINUTES_PER_DAY);
  if (phases.length === 0) {
    throw new SchedulingInputError(`${field}.phases`, 'o serviço precisa de ao menos uma fase');
  }

  const pieces: LabeledMinuteRange[] = [];
  if (bufferBeforeMinutes > 0) {
    pieces.push({ kind: 'buffer', startMinute: -bufferBeforeMinutes, endMinute: 0 });
  }
  let offset = 0;
  for (const [index, phase] of phases.entries()) {
    const at = `${field}.phases[${index}]`;
    if (!PHASE_KINDS.has(phase.kind)) {
      throw new SchedulingInputError(`${at}.kind`, `tipo de fase desconhecido "${phase.kind}"`);
    }
    assertIntegerInRange(`${at}.minutes`, phase.minutes, 1, MINUTES_PER_DAY);
    if (phase.kind === 'work') {
      pieces.push({ kind: 'service', startMinute: offset, endMinute: offset + phase.minutes });
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
    pieces.push({ kind: 'buffer', startMinute: offset, endMinute: offset + bufferAfterMinutes });
  }
  return { durationMinutes: offset, pieces };
}

/** Une trechos já ordenados que se tocam ou se sobrepõem (sem o tipo: só o tempo ocupado). */
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
      joined.push({ startMinute: piece.startMinute, endMinute: piece.endMinute });
    }
  }
  return joined;
}
