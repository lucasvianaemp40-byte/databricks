/**
 * Ciclo de vida do agendamento. Função pura: decide se uma mudança de status é válida;
 * efeitos (liberar ocupações, notificar, comissão) ficam com quem chama.
 *
 *   (novo) -> pending -> confirmed -> checked_in -> in_service -> completed
 *   (novo) -> confirmed            (sem sinal nem aprovação)
 *   pending -> expired -> confirmed (Pix pago depois do hold; o EXCLUDE do banco re-checa)
 *   confirmed -> in_service | completed (muitos salões não fazem check-in)
 *   pending | confirmed | checked_in -> cancelled_by_customer | cancelled_by_salon
 *   confirmed -> no_show -> checked_in (correção: o cliente chegou atrasado)
 *   completed, cancelled_by_customer, cancelled_by_salon: terminais. Remarcar cria outro
 *   agendamento.
 *
 * Quem pode disparar cada transição (cliente, equipe, sistema) é regra de autorização e
 * entra com a autenticação, numa próxima iteração.
 */
export const APPOINTMENT_STATUSES = Object.freeze([
  'pending',
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
  'cancelled_by_customer',
  'cancelled_by_salon',
  'no_show',
  'expired',
] as const);

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Status possíveis na criação: 'pending' (exige sinal ou aprovação) ou 'confirmed'. */
export const INITIAL_APPOINTMENT_STATUSES = Object.freeze([
  'pending',
  'confirmed',
] as const satisfies readonly AppointmentStatus[]);

/** Lista congelada de destinos: allowedTransitions a devolve, e ninguém pode alterá-la. */
const allow = (...targets: readonly AppointmentStatus[]): readonly AppointmentStatus[] =>
  Object.freeze([...targets]);

const TRANSITIONS: { readonly [S in AppointmentStatus]: readonly AppointmentStatus[] } =
  Object.freeze({
    pending: allow('confirmed', 'cancelled_by_customer', 'cancelled_by_salon', 'expired'),
    confirmed: allow(
      'checked_in',
      'in_service',
      'completed',
      'cancelled_by_customer',
      'cancelled_by_salon',
      'no_show',
    ),
    checked_in: allow('in_service', 'completed', 'cancelled_by_customer', 'cancelled_by_salon'),
    in_service: allow('completed'),
    completed: allow(),
    cancelled_by_customer: allow(),
    cancelled_by_salon: allow(),
    no_show: allow('checked_in'),
    expired: allow('confirmed'),
  });

/** Status cujas ocupações (`occupancies`) deixam de valer (o horário volta a ficar livre). */
const RELEASING_STATUSES: ReadonlySet<AppointmentStatus> = new Set<AppointmentStatus>([
  'cancelled_by_customer',
  'cancelled_by_salon',
  'no_show',
  'expired',
]);

const KNOWN_STATUSES: ReadonlySet<string> = new Set<string>(APPOINTMENT_STATUSES);

/** Valida texto vindo do banco ou da API. */
export function isAppointmentStatus(value: unknown): value is AppointmentStatus {
  return typeof value === 'string' && KNOWN_STATUSES.has(value);
}

/** Destinos válidos a partir de `from` (vazio para status terminal ou desconhecido). */
export function allowedTransitions(from: AppointmentStatus): readonly AppointmentStatus[] {
  return isAppointmentStatus(from) ? TRANSITIONS[from] : [];
}

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return allowedTransitions(from).includes(to);
}

/** Terminal: nenhuma transição sai dele. */
export function isTerminalStatus(status: AppointmentStatus): boolean {
  return isAppointmentStatus(status) && TRANSITIONS[status].length === 0;
}

/** O agendamento nesse status mantém o horário ocupado (ocupações ativas)? */
export function occupiesSchedule(status: AppointmentStatus): boolean {
  return isAppointmentStatus(status) && !RELEASING_STATUSES.has(status);
}

export type AppointmentTransitionErrorCode =
  /** `from` ou `to` não é um status conhecido (dado corrompido ou versão antiga). */
  | 'unknown_status'
  /** `from` = `to`: nada muda. O chamador decide se trata como idempotente. */
  | 'unchanged'
  /** `from` é terminal. */
  | 'terminal_status'
  /** A tabela não permite `from` -> `to`. */
  | 'transition_not_allowed';

const MESSAGES: {
  readonly [C in AppointmentTransitionErrorCode]: (from: string, to: string) => string;
} = {
  unknown_status: (from, to) => `Status desconhecido na transição ${from} -> ${to}`,
  unchanged: (from) => `O agendamento já está em ${from}`,
  terminal_status: (from, to) => `Status terminal não admite transição: ${from} -> ${to}`,
  transition_not_allowed: (from, to) => `Transição de status inválida: ${from} -> ${to}`,
};

/** Transição de status recusada. É um Error de verdade: pode ser lançado pelo chamador. */
export class AppointmentTransitionError extends Error {
  override readonly name = 'AppointmentTransitionError';
  readonly code: AppointmentTransitionErrorCode;
  readonly from: string;
  readonly to: string;

  constructor(code: AppointmentTransitionErrorCode, from: string, to: string) {
    super(MESSAGES[code](from, to));
    this.code = code;
    this.from = from;
    this.to = to;
  }
}

export type TransitionResult =
  | { readonly ok: true; readonly from: AppointmentStatus; readonly to: AppointmentStatus }
  | { readonly ok: false; readonly error: AppointmentTransitionError };

/** Decide a transição `from` -> `to` sem efeitos colaterais. */
export function transitionAppointmentStatus(
  from: AppointmentStatus,
  to: AppointmentStatus,
): TransitionResult {
  const reject = (code: AppointmentTransitionErrorCode): TransitionResult => ({
    ok: false,
    error: new AppointmentTransitionError(code, from, to),
  });
  if (!isAppointmentStatus(from) || !isAppointmentStatus(to)) return reject('unknown_status');
  if (from === to) return reject('unchanged');
  const allowed = TRANSITIONS[from];
  if (allowed.length === 0) return reject('terminal_status');
  if (!allowed.includes(to)) return reject('transition_not_allowed');
  return { ok: true, from, to };
}
