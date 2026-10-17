import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Runner de migrações do @salon/db.
 *
 * Por que não `drizzle-kit migrate`/`migrate()` do Drizzle:
 * - troca de papel: a migração marcada como privilegiada (0000, papéis e extensão) roda com
 *   o usuário da conexão; todas as outras rodam com `SET LOCAL ROLE app_migrator`, que fica
 *   dono de todos os objetos (o dono também obedece à RLS por causa do FORCE);
 * - `pg_advisory_xact_lock`: dois deploys simultâneos não aplicam a mesma migração duas vezes;
 * - imutabilidade: recusa migração já aplicada cujo arquivo mudou (hash) e migração nova com
 *   timestamp anterior à última aplicada (o Drizzle a ignoraria em silêncio);
 * - ao final de TODA execução chama `app_private.assert_security_invariants()`: se RLS,
 *   papéis ou privilégios regrediram (inclusive por GRANT manual), nada é commitado.
 *
 * A contabilidade é a mesma do Drizzle (`drizzle.__drizzle_migrations`: hash sha256 do
 * arquivo e `created_at` = `when` do journal), então as ferramentas do drizzle-kit continuam
 * enxergando o mesmo estado. Tudo roda em UMA transação: ou aplica tudo, ou nada.
 */

export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Papel dono do schema, assumido via SET ROLE pelas migrações não privilegiadas. */
export const MIGRATION_OWNER_ROLE = 'app_migrator';

/** Primeira linha de uma migração que precisa rodar com o usuário da conexão. */
export const PRIVILEGED_MIGRATION_MARKER = '-- @salon/db run-as: session-user';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';
const BOOKKEEPING_TABLE = 'drizzle.__drizzle_migrations';
/** Chave arbitrária e fixa do advisory lock que serializa runners concorrentes. */
const MIGRATION_LOCK_KEY = '7315420610';
const INVARIANTS_FUNCTION = 'app_private.assert_security_invariants()';

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** O histórico aplicado no banco não bate com os arquivos do repositório. */
export class MigrationIntegrityError extends MigrationError {}

export interface MigrationFile {
  readonly tag: string;
  /** Timestamp (ms) do journal; vira `created_at` na tabela de controle. */
  readonly when: number;
  /** sha256 hex do arquivo, igual ao calculado pelo Drizzle. */
  readonly hash: string;
  readonly statements: readonly string[];
  readonly privileged: boolean;
}

interface JournalEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
}

const TAG_PATTERN = /^\d{4}_[a-z0-9_]+$/;

function parseJournal(raw: string, journalPath: string): JournalEntry[] {
  const parsed: unknown = JSON.parse(raw);
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new MigrationIntegrityError(`journal inválido (sem "entries"): ${journalPath}`);
  }
  return entries.map((entry: unknown, position) => {
    const { idx, when, tag } = entry as Partial<Record<'idx' | 'when' | 'tag', unknown>>;
    if (
      idx !== position ||
      typeof when !== 'number' ||
      !Number.isSafeInteger(when) ||
      typeof tag !== 'string' ||
      !TAG_PATTERN.test(tag)
    ) {
      throw new MigrationIntegrityError(`entrada ${position} inválida no journal ${journalPath}`);
    }
    return { idx, when, tag };
  });
}

/** Lê o journal e os arquivos SQL de uma pasta de migrações do drizzle-kit. */
export function loadMigrations(folder: string = DEFAULT_MIGRATIONS_FOLDER): MigrationFile[] {
  const journalPath = join(folder, 'meta', '_journal.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta de migrações do próprio pacote (ou de teste), nunca entrada de usuário.
  const journal = parseJournal(readFileSync(journalPath, 'utf8'), journalPath);

  let previousWhen = Number.NEGATIVE_INFINITY;
  return journal.map((entry) => {
    if (entry.when <= previousWhen) {
      throw new MigrationIntegrityError(
        `journal fora de ordem: ${entry.tag} tem timestamp menor ou igual ao da anterior`,
      );
    }
    previousWhen = entry.when;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tag validada por TAG_PATTERN.
    const content = readFileSync(join(folder, `${entry.tag}.sql`), 'utf8');
    const statements = content
      .split(STATEMENT_BREAKPOINT)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    return {
      tag: entry.tag,
      when: entry.when,
      hash: createHash('sha256').update(content).digest('hex'),
      statements,
      privileged: content.trimStart().startsWith(PRIVILEGED_MIGRATION_MARKER),
    };
  });
}

export interface RunMigrationsOptions {
  /** Superusuário (dev/CI) ou admin do provedor com CREATEROLE e SET em app_migrator. */
  readonly databaseUrl: string;
  readonly migrationsFolder?: string;
  /** `lock_timeout` aplicado ao DDL (padrão 10 s): não enfileira atrás de tráfego indefinidamente. */
  readonly lockTimeoutMs?: number;
  readonly log?: (message: string) => void;
}

export interface MigrationRunResult {
  /** Tags aplicadas nesta execução, em ordem. */
  readonly applied: readonly string[];
  /** Quantas já estavam aplicadas. */
  readonly alreadyApplied: number;
}

interface AppliedRow {
  readonly hash: string;
  readonly created_at: string;
}

function verifyHistory(
  applied: readonly AppliedRow[],
  migrations: readonly MigrationFile[],
): MigrationFile[] {
  const byWhen = new Map(migrations.map((migration) => [migration.when, migration]));
  const appliedWhens = new Set<number>();
  for (const row of applied) {
    const when = Number(row.created_at);
    const migration = byWhen.get(when);
    if (migration === undefined) {
      throw new MigrationIntegrityError(
        `o banco tem uma migração aplicada (created_at=${row.created_at}) que não existe no ` +
          'repositório: o código está atrás do banco ou um arquivo de migração foi removido.',
      );
    }
    if (migration.hash !== row.hash) {
      throw new MigrationIntegrityError(
        `a migração ${migration.tag} foi alterada depois de aplicada (hash diferente). ` +
          'Migrações são imutáveis: restaure o arquivo original e crie uma migração nova.',
      );
    }
    appliedWhens.add(when);
  }

  const lastApplied = Math.max(Number.NEGATIVE_INFINITY, ...appliedWhens);
  const pending = migrations.filter((migration) => !appliedWhens.has(migration.when));
  const outOfOrder = pending.filter((migration) => migration.when <= lastApplied);
  if (outOfOrder.length > 0) {
    throw new MigrationIntegrityError(
      `migrações pendentes com timestamp anterior à última aplicada: ${outOfOrder
        .map((migration) => migration.tag)
        .join(', ')}. Regere-as (drizzle-kit generate) para que fiquem depois do histórico.`,
    );
  }
  return pending;
}

async function assertCanAssumeOwner(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ exists: boolean; can_set: boolean | null }>(
    `SELECT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = $1) AS exists,
            CASE WHEN EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = $1)
                 THEN pg_catalog.pg_has_role(current_user, $1, 'SET') END AS can_set`,
    [MIGRATION_OWNER_ROLE],
  );
  const row = rows[0];
  if (row?.exists !== true) {
    throw new MigrationError(
      `papel ${MIGRATION_OWNER_ROLE} não existe: a migração de bootstrap (0000) precisa rodar primeiro.`,
    );
  }
  if (row.can_set !== true) {
    throw new MigrationError(
      `o usuário da conexão não pode assumir ${MIGRATION_OWNER_ROLE}. ` +
        `Como admin: GRANT ${MIGRATION_OWNER_ROLE} TO <usuario> WITH INHERIT FALSE, SET TRUE;`,
    );
  }
}

async function applyMigration(client: pg.Client, migration: MigrationFile): Promise<void> {
  if (!migration.privileged) {
    await assertCanAssumeOwner(client);
    await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(MIGRATION_OWNER_ROLE)}`);
  }
  for (const [index, statement] of migration.statements.entries()) {
    try {
      await client.query(statement);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MigrationError(
        `falha ao aplicar ${migration.tag} (comando ${index + 1}/${migration.statements.length}): ${reason}`,
        { cause: error },
      );
    }
  }
  await client.query('SET LOCAL ROLE NONE');
  await client.query(`INSERT INTO ${BOOKKEEPING_TABLE} (hash, created_at) VALUES ($1, $2)`, [
    migration.hash,
    migration.when,
  ]);
}

async function assertSecurityInvariants(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ present: boolean }>(
    'SELECT to_regprocedure($1) IS NOT NULL AS present',
    [INVARIANTS_FUNCTION],
  );
  if (rows[0]?.present !== true) {
    return;
  }
  await assertCanAssumeOwner(client);
  await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(MIGRATION_OWNER_ROLE)}`);
  try {
    await client.query(`SELECT ${INVARIANTS_FUNCTION}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MigrationError(`verificação de segurança pós-migração falhou: ${reason}`, {
      cause: error,
    });
  }
  await client.query('SET LOCAL ROLE NONE');
}

/** Aplica as migrações pendentes em uma única transação. */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationRunResult> {
  const migrations = loadMigrations(options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER);
  const log = options.log ?? (() => undefined);
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new TypeError('runMigrations: lockTimeoutMs precisa ser um inteiro >= 0');
  }

  const client = new pg.Client({
    connectionString: options.databaseUrl,
    application_name: 'salon-migrate',
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
      await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${BOOKKEEPING_TABLE} (
           id SERIAL PRIMARY KEY,
           hash text NOT NULL,
           created_at bigint
         )`,
      );
      const { rows: applied } = await client.query<AppliedRow>(
        `SELECT hash, created_at FROM ${BOOKKEEPING_TABLE} ORDER BY created_at, id`,
      );
      const pending = verifyHistory(applied, migrations);

      for (const migration of pending) {
        log(`aplicando ${migration.tag}${migration.privileged ? ' (privilegiada)' : ''}`);
        await applyMigration(client, migration);
      }
      await assertSecurityInvariants(client);
      await client.query('COMMIT');

      log(
        pending.length === 0
          ? `nenhuma migração pendente (${applied.length} já aplicadas)`
          : `${pending.length} migração(ões) aplicada(s)`,
      );
      return {
        applied: pending.map((migration) => migration.tag),
        alreadyApplied: applied.length,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
  }
}
