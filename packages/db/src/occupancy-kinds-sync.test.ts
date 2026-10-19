import { readdirSync, readFileSync } from 'node:fs';
import { OCCUPANCY_KINDS } from '@salon/scheduling-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { occupancies } from './schema';
import { occupancyKinds } from './schema/values';

/**
 * Os tipos de ocupação moram no domínio (`OCCUPANCY_KINDS` do @salon/scheduling-core: o que a
 * reserva grava) e o banco os repete na coluna `occupancies.kind` e no CHECK
 * `occupancies_kind_valid`. Estes testes, sem banco, falham se divergirem: um tipo novo no core
 * que o CHECK não conhece faria a reserva falhar em produção com 23514; um tipo a mais no banco
 * deixaria gravar ocupação que o cálculo de disponibilidade não entende.
 * constraints.int.test.ts confirma no catálogo do PostgreSQL real.
 */
const CONSTRAINT = 'occupancies_kind_valid';
const migrationsFolder = new URL('../drizzle/', import.meta.url);

const sorted = (values: readonly string[]): string[] => [...values].sort();

/**
 * Última linha de migração que menciona o CHECK, na ordem de aplicação: é a definição que vale
 * no banco. Se uma migração posterior só o apagar, a última menção é o DROP e o teste falha.
 */
function lastMigrationMention(): string {
  const mentions = readdirSync(migrationsFolder)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .flatMap((file) =>
      readFileSync(new URL(file, migrationsFolder), 'utf8')
        .split('\n')
        .filter((line) => line.includes(`"${CONSTRAINT}"`) || line.includes(` ${CONSTRAINT} `)),
    );
  const last = mentions.at(-1);
  if (last === undefined) {
    throw new Error(`nenhuma migração define o CHECK ${CONSTRAINT}`);
  }
  return last;
}

/** Valores do `kind IN (...)` de uma definição de CHECK gerada pelo drizzle-kit. */
function kindsFromCheck(definition: string): string[] {
  const list = /CHECK \("app"\."occupancies"\."kind" IN \(([^)]*)\)\)/.exec(definition)?.[1];
  if (list === undefined) {
    throw new Error(`definição inesperada do CHECK ${CONSTRAINT}: ${definition.trim()}`);
  }
  return [...list.matchAll(/'([a-z_]+)'/g)].map(([, kind]) => kind ?? '');
}

describe('tipos de ocupação: banco x domínio', () => {
  it('a lista do schema é a OCCUPANCY_KINDS do core', () => {
    expect(sorted(occupancyKinds)).toEqual(sorted(OCCUPANCY_KINDS));
  });

  it('a coluna occupancies.kind aceita exatamente os tipos do core', () => {
    const kind = getTableConfig(occupancies).columns.find((column) => column.name === 'kind');
    expect(sorted(kind?.enumValues ?? [])).toEqual(sorted(OCCUPANCY_KINDS));
  });

  it('o schema Drizzle declara o CHECK occupancies_kind_valid', () => {
    const names = getTableConfig(occupancies).checks.map((check) => check.name);
    expect(names).toContain(CONSTRAINT);
  });

  it('a definição vigente do CHECK nas migrações lista os mesmos tipos do core', () => {
    expect(sorted(kindsFromCheck(lastMigrationMention()))).toEqual(sorted(OCCUPANCY_KINDS));
  });

  it('o leitor do CHECK acusa definição que ele não entende (falha fechada)', () => {
    expect(
      kindsFromCheck(
        `CONSTRAINT "${CONSTRAINT}" CHECK ("app"."occupancies"."kind" IN ('a', 'b_c'))`,
      ),
    ).toEqual(['a', 'b_c']);
    expect(() =>
      kindsFromCheck(`ALTER TABLE "app"."occupancies" DROP CONSTRAINT "${CONSTRAINT}";`),
    ).toThrow(CONSTRAINT);
  });
});
