import { SchedulingInputError } from '../errors';

/** Minutos num dia local (24 h). 1440 representa 24:00, o fim do dia. */
export const MINUTES_PER_DAY = 1440;

// HH:MM em 24 h, ou 24:00. Sem segundos: a agenda trabalha em minutos.
const WALL_TIME = /^(?:([01]\d|2[0-3]):([0-5]\d)|(24):00)$/;

interface ParseWallTimeOptions {
  /** Aceita '24:00' (fim do dia local). Use só para o fim de um turno. */
  readonly allowEndOfDay?: boolean;
  /** Nome do campo para a mensagem de erro. */
  readonly field?: string;
}

/**
 * Converte hora de parede 'HH:MM' em minutos desde a meia-noite local.
 * Hora de parede não é instante: só vira instante junto com uma data e um fuso IANA.
 */
export function parseWallTime(value: string, options: ParseWallTimeOptions = {}): number {
  const { allowEndOfDay = false, field = 'wallTime' } = options;
  const match = WALL_TIME.exec(value);
  if (match === null) {
    throw new SchedulingInputError(field, `hora inválida "${value}": use HH:MM (00:00 a 23:59)`);
  }
  const [, hours, minutes, endOfDay] = match;
  if (endOfDay !== undefined) {
    if (!allowEndOfDay) {
      throw new SchedulingInputError(field, '24:00 só é aceito como fim de turno');
    }
    return MINUTES_PER_DAY;
  }
  return Number(hours) * 60 + Number(minutes);
}

/** Formata minutos desde a meia-noite local (0 a 1440) como 'HH:MM'. */
export function formatWallTime(minuteOfDay: number): string {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > MINUTES_PER_DAY) {
    throw new RangeError(`minuto do dia fora de 0..1440: ${String(minuteOfDay)}`);
  }
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
