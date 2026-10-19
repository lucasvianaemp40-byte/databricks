import { readFileSync } from 'node:fs';
import {
  APPOINTMENT_STATUSES,
  allowedTransitions,
  INITIAL_APPOINTMENT_STATUSES,
  occupiesSchedule,
} from '@salon/scheduling-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { appointmentEvents, appointments } from './schema';

/**
 * A máquina de estados mora no domínio (@salon/scheduling-core). O banco a repete em SQL
 * (CHECK + trigger da migração 0003) como defesa em profundidade. Estes testes, sem banco,
 * falham se as duas divergirem; status-transitions.int.test.ts confirma no PostgreSQL real.
 */
const securityMigration = readFileSync(
  new URL('../drizzle/0003_tenant_security.sql', import.meta.url),
  'utf8',
);

/** Extrai a tabela de transições do CASE do trigger appointments_guard_status. */
function transitionsFromSql(): Record<string, string[]> {
  const body = /CREATE FUNCTION app_private\.appointments_guard_status\(\)[\s\S]*?\n\$\$;/.exec(
    securityMigration,
  )?.[0];
  if (body === undefined) {
    throw new Error('função appointments_guard_status não encontrada na migração 0003');
  }
  const table: Record<string, string[]> = {};
  for (const match of body.matchAll(/WHEN '([a-z_]+)'\s+THEN ARRAY\[([^\]]*)\]/g)) {
    const [, from, list] = match;
    if (from !== undefined && list !== undefined) {
      table[from] = [...list.matchAll(/'([a-z_]+)'/g)].map(([, status]) => status ?? '');
    }
  }
  return table;
}

const quoted = (statuses: readonly string[]) => statuses.map((status) => `'${status}'`).join(', ');

describe('máquina de estados: banco x domínio', () => {
  it('a tabela do trigger SQL é idêntica a allowedTransitions() do core', () => {
    const fromCore = Object.fromEntries(
      APPOINTMENT_STATUSES.filter((status) => allowedTransitions(status).length > 0).map(
        (status) => [status, [...allowedTransitions(status)]],
      ),
    );
    expect(transitionsFromSql()).toEqual(fromCore);
  });

  it('a lista de status que ocupam a agenda nos triggers SQL é a do core', () => {
    const occupying = APPOINTMENT_STATUSES.filter((status) => occupiesSchedule(status));
    // Aparece no trigger que deriva `active`, no que sincroniza as ocupações e na checagem de
    // completude das ocupações no COMMIT (appointments_assert_occupancy).
    expect(securityMigration.split(quoted(occupying)).length - 1).toBe(3);
  });

  it('os estados iniciais aceitos pelo trigger são os do core', () => {
    expect(securityMigration).toContain(
      `IF NEW.status NOT IN (${quoted(INITIAL_APPOINTMENT_STATUSES)}) THEN`,
    );
  });

  it('as colunas de status do schema usam exatamente a lista do core', () => {
    const enumOf = (table: typeof appointments | typeof appointmentEvents, column: string) =>
      getTableConfig(table).columns.find((candidate) => candidate.name === column)?.enumValues;
    expect(enumOf(appointments, 'status')).toEqual([...APPOINTMENT_STATUSES]);
    expect(enumOf(appointmentEvents, 'from_status')).toEqual([...APPOINTMENT_STATUSES]);
    expect(enumOf(appointmentEvents, 'to_status')).toEqual([...APPOINTMENT_STATUSES]);
  });

  it('o CHECK gerado na migração 0002 lista os mesmos status', () => {
    const schemaMigration = readFileSync(
      new URL('../drizzle/0002_schema.sql', import.meta.url),
      'utf8',
    );
    expect(schemaMigration).toContain(`"status" IN (${quoted(APPOINTMENT_STATUSES)})`);
  });
});
