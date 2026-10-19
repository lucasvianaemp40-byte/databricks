import { type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, customType, pgSchema, timestamp, uuid } from 'drizzle-orm/pg-core';
import { newId } from '../ids';

/**
 * Schema dos dados de tenant (todas as tabelas com RLS). Funções, tipos e triggers ficam em
 * `app_private`, criado pela migração custom 0001 e sem USAGE para os papéis da aplicação.
 */
export const appSchema = pgSchema('app');

/**
 * Tenant da transação corrente, definido por `withTenant` com
 * `set_config('app.tenant_id', <uuid>, true)`.
 *
 * O NULLIF é obrigatório: depois que uma transação com `set_config(..., true)` termina, a
 * mesma conexão devolve '' (não NULL) para o GUC, e `''::uuid` lançaria 22P02. Sem contexto,
 * a expressão vale NULL: nenhuma linha casa com a política, e um INSERT sem tenant_id é
 * recusado pela RLS (42501, avaliada antes do NOT NULL). Ou seja, falha fechada.
 */
const currentTenantIdSql: SQL = sql`NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/** PK UUIDv7 gerada na aplicação; o default do banco (v4) só cobre SQL manual e triggers. */
export const idColumn = () => uuid('id').primaryKey().defaultRandom().$defaultFn(newId);

/** `tenant_id NOT NULL`, preenchido pelo contexto da transação quando omitido no INSERT. */
export const tenantIdColumn = () => uuid('tenant_id').notNull().default(currentTenantIdSql);

/**
 * Instante absoluto (timestamptz) lido como `Date` (sempre em UTC dentro de `withTenant`).
 *
 * Precisão: MILISSEGUNDO. O `Date` do driver descarta microssegundos, então horários de agenda
 * (início/fim de agendamento, item, ocupação e bloqueio) têm CHECK `<tabela>_instant_precision`
 * (`instantHasMillisecondPrecision`). SQL manual ou job que grave esses horários usa
 * `date_trunc('milliseconds', ...)` (ou minuto), nunca `now()` cru.
 */
export const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** `<coluna> = date_trunc('milliseconds', <coluna>)` para cada coluna (instante sem microssegundos). */
export function instantHasMillisecondPrecision(...columns: AnyPgColumn[]): SQL {
  return sql.join(
    columns.map((column) => sql`date_trunc('milliseconds', ${column}) = ${column}`),
    sql` AND `,
  );
}

/** `created_at`/`updated_at`; `updated_at` é mantido pelo trigger `touch_updated_at`. */
export const timestamps = () => ({
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

/**
 * `tstzrange` somente leitura (colunas geradas `during`, usadas por EXCLUDE e índices GiST).
 * O valor chega como texto do PostgreSQL; a aplicação lê e escreve `starts_at`/`ends_at`.
 */
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange';
  },
});

const SQL_LIST_ITEM = /^[a-z][a-z0-9_]*$/;

/**
 * Lista SQL de literais para CHECK (`'a', 'b'`) a partir de constantes do código, para que
 * CHECK e tipos TypeScript venham da mesma fonte. Só aceita identificadores simples: os
 * valores são constantes de compilação, nunca entrada de usuário.
 */
export function sqlStringList(values: readonly string[]): SQL {
  if (values.length === 0) {
    throw new Error('sqlStringList: lista vazia');
  }
  for (const value of values) {
    if (!SQL_LIST_ITEM.test(value)) {
      throw new Error(`sqlStringList: valor não permitido em CHECK: ${JSON.stringify(value)}`);
    }
  }
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

/**
 * `<coluna> ~ '<regex>'` com a regex como literal SQL (não como parâmetro: DDL de CHECK não
 * aceita parâmetros). A regex é uma constante do código e não pode conter aspas simples.
 */
export function matchesPattern(column: SQL | AnyPgColumn, pattern: string): SQL {
  if (pattern.includes("'")) {
    throw new Error('matchesPattern: a regex não pode conter aspas simples');
  }
  return sql`${column} ~ ${sql.raw(`'${pattern}'`)}`;
}

/** Telefone em E.164 (+ e 8 a 15 dígitos, sem zero inicial no código do país). */
export const E164_PATTERN = '^\\+[1-9][0-9]{7,14}$';
