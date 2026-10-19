// API pública do domínio de agendamento. Puro: sem I/O, sem relógio global, sem aleatoriedade.
// Pacote interno: exporta o fonte TypeScript (o Next transpila via transpilePackages).

export {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  AppointmentTransitionError,
  type AppointmentTransitionErrorCode,
  allowedTransitions,
  canTransition,
  INITIAL_APPOINTMENT_STATUSES,
  isAppointmentStatus,
  isTerminalStatus,
  occupiesSchedule,
  type TransitionResult,
  transitionAppointmentStatus,
} from './appointment/appointment-status';
export {
  type AvailabilityInput,
  type AvailableSlot,
  computeAvailableSlots,
  type IsoWeekday,
  MAX_CANDIDATE_STARTS,
  MAX_NOTICE_MINUTES,
  MAX_RANGE_DAYS,
  type WorkShift,
} from './availability/compute-available-slots';
export {
  type MinuteRange,
  OCCUPANCY_KINDS,
  type OccupancyKind,
  type OccupancySegment,
  type ServiceDefinition,
  type ServiceFootprint,
  type ServicePhase,
  type ServicePhaseKind,
  serviceFootprint,
  singlePhaseService,
  staffBusyIntervals,
  staffOccupancySegments,
} from './availability/service';
export { SchedulingInputError } from './errors';
export { type Clock, fixedClock, systemClock } from './time/clock';
export {
  compareIntervals,
  containsInterval,
  type Interval,
  intersectIntervals,
  interval,
  isEmptyInterval,
  mergeIntervals,
  overlaps,
  sortIntervals,
  subtractIntervals,
} from './time/intervals';
export { assertIanaTimeZone, wallTimeToInstant } from './time/local-day';
export { formatWallTime, parseWallTime } from './time/wall-time';
