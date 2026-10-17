import { randomBytes } from 'node:crypto';
import type { Database } from '../../src/client';
import { newId } from '../../src/ids';
import {
  appointmentItems,
  appointments,
  customers,
  locations,
  occupancies,
  services,
  staff,
  staffServices,
  tenants,
  timeOff,
  workingHours,
} from '../../src/schema';
import { type TenantTransaction, withTenant } from '../../src/tenant';

export const TIMEZONE = 'America/Sao_Paulo';

/** Dados mínimos de um salão, com pelo menos uma linha em TODA tabela de tenant. */
export interface TenantFixture {
  readonly tenantId: string;
  readonly slug: string;
  readonly locationId: string;
  readonly staffIds: readonly [string, string];
  readonly serviceId: string;
  readonly customerId: string;
  /** Agendamento confirmado criado com o fixture (gera item, ocupação e evento). */
  readonly appointmentId: string;
}

export interface BookingRequest {
  readonly staffId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status?: 'pending' | 'confirmed';
  readonly holdExpiresAt?: Date;
  readonly idempotencyKey?: string;
}

export interface BookedAppointment {
  readonly appointmentId: string;
  readonly itemId: string;
  readonly occupancyId: string;
}

export function first<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('esperava ao menos uma linha');
  }
  return row;
}

/** Hora de parede ('YYYY-MM-DD HH:MM:SS') de um instante no fuso da unidade. */
export function wallTime(instant: Date, timeZone: string = TIMEZONE): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

export function randomIdempotencyKey(): string {
  return `test-${randomBytes(8).toString('hex')}`;
}

/** Cria visita + item + ocupação do profissional (como faria o caso de uso de reserva). */
export async function bookAppointment(
  tx: TenantTransaction,
  fixture: TenantFixture,
  request: BookingRequest,
): Promise<BookedAppointment> {
  const status = request.status ?? 'confirmed';
  const appointment = first(
    await tx
      .insert(appointments)
      .values({
        locationId: fixture.locationId,
        customerId: fixture.customerId,
        status,
        source: 'staff',
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        localStartsAt: wallTime(request.startsAt),
        timezone: TIMEZONE,
        holdExpiresAt:
          request.holdExpiresAt ?? (status === 'pending' ? new Date('2099-01-01T00:00:00Z') : null),
        idempotencyKey: request.idempotencyKey ?? randomIdempotencyKey(),
      })
      .returning({ id: appointments.id }),
  );
  const durationMin = Math.round((request.endsAt.getTime() - request.startsAt.getTime()) / 60_000);
  const item = first(
    await tx
      .insert(appointmentItems)
      .values({
        appointmentId: appointment.id,
        position: 1,
        serviceId: fixture.serviceId,
        staffId: request.staffId,
        serviceName: 'Corte',
        durationMin,
        priceCents: 6000,
        commissionBps: 4000,
        startsAt: request.startsAt,
        endsAt: request.endsAt,
      })
      .returning({ id: appointmentItems.id }),
  );
  const occupancy = first(
    await tx
      .insert(occupancies)
      .values({
        appointmentId: appointment.id,
        appointmentItemId: item.id,
        staffId: request.staffId,
        startsAt: request.startsAt,
        endsAt: request.endsAt,
      })
      .returning({ id: occupancies.id }),
  );
  return { appointmentId: appointment.id, itemId: item.id, occupancyId: occupancy.id };
}

/** Cria um salão completo pelo caminho da aplicação (app_user + withTenant). */
export async function createTenantFixture(db: Database): Promise<TenantFixture> {
  const tenantId = newId();
  const slug = `salao-${randomBytes(5).toString('hex')}`;
  return withTenant(
    db,
    tenantId,
    async (tx) => {
      await tx.insert(tenants).values({ id: tenantId, slug, name: `Salão ${slug}` });
      const location = first(
        await tx
          .insert(locations)
          .values({ name: 'Centro', slug: 'centro', timezone: TIMEZONE })
          .returning({ id: locations.id }),
      );
      const staffRows = await tx
        .insert(staff)
        .values([
          { displayName: 'Ana', engagementType: 'owner' },
          { displayName: 'Bruno', engagementType: 'partner', defaultCommissionBps: 5000 },
        ])
        .returning({ id: staff.id });
      const firstStaff = first(staffRows).id;
      const secondStaff = first(staffRows.slice(1)).id;
      const service = first(
        await tx
          .insert(services)
          .values({
            name: 'Corte',
            durationMin: 60,
            phases: [{ kind: 'work', minutes: 60 }],
            priceCents: 6000,
          })
          .returning({ id: services.id }),
      );
      await tx
        .insert(staffServices)
        .values({ staffId: firstStaff, serviceId: service.id, priceCents: 8000 });
      await tx.insert(workingHours).values({
        staffId: firstStaff,
        locationId: location.id,
        weekday: 1,
        startTime: '09:00',
        endTime: '12:00',
        validFrom: '2026-01-01',
      });
      await tx.insert(timeOff).values({
        staffId: secondStaff,
        kind: 'vacation',
        startsAt: new Date('2027-01-04T03:00:00Z'),
        endsAt: new Date('2027-01-11T03:00:00Z'),
      });
      const customer = first(
        await tx
          .insert(customers)
          .values({ fullName: 'Cliente Teste', phoneE164: '+5511999990001' })
          .returning({ id: customers.id }),
      );
      const partial = {
        tenantId,
        slug,
        locationId: location.id,
        staffIds: [firstStaff, secondStaff] as const,
        serviceId: service.id,
        customerId: customer.id,
        appointmentId: '',
      };
      const booked = await bookAppointment(tx, partial, {
        staffId: firstStaff,
        startsAt: new Date('2026-12-01T12:00:00Z'),
        endsAt: new Date('2026-12-01T13:00:00Z'),
      });
      return { ...partial, appointmentId: booked.appointmentId };
    },
    { actor: { type: 'staff', id: 'fixture' } },
  );
}
