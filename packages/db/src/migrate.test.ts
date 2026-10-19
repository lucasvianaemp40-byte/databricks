import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_FOLDER,
  INVARIANTS_FUNCTION_SHA256,
  loadMigrations,
  MigrationIntegrityError,
  PRIVILEGED_MIGRATION_MARKER,
} from './migrate';

describe('loadMigrations', () => {
  const temporaryFolders: string[] = [];

  afterEach(() => {
    for (const folder of temporaryFolders.splice(0)) {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  interface JournalFile {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  }

  function copyWithJournal(edit: (journal: JournalFile) => void): string {
    const folder = mkdtempSync(join(tmpdir(), 'salon-migrations-unit-'));
    temporaryFolders.push(folder);
    cpSync(DEFAULT_MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalFile;
    edit(journal);
    writeFileSync(journalPath, JSON.stringify(journal));
    return folder;
  }

  it('calcula os mesmos hashes e timestamps que o Drizzle (contabilidade compatível)', () => {
    const ours = loadMigrations();
    const drizzle = readMigrationFiles({ migrationsFolder: DEFAULT_MIGRATIONS_FOLDER });
    expect(ours.map(({ hash, when }) => ({ hash, when }))).toEqual(
      drizzle.map(({ hash, folderMillis }) => ({ hash, when: folderMillis })),
    );
  });

  it('só a migração de bootstrap (papéis e extensão) roda com o usuário da conexão', () => {
    const privileged = loadMigrations()
      .filter((migration) => migration.privileged)
      .map((migration) => migration.tag);
    expect(privileged).toEqual(['0000_bootstrap_roles_extensions']);
    expect(
      readFileSync(join(DEFAULT_MIGRATIONS_FOLDER, '0000_bootstrap_roles_extensions.sql'), 'utf8'),
    ).toMatch(new RegExp(`^${PRIVILEGED_MIGRATION_MARKER}\\n`));
  });

  it('nenhuma migração usa recursos exclusivos do PostgreSQL 17/18 (alvo: 16 e 18)', () => {
    const sql = loadMigrations()
      .flatMap((migration) => migration.statements)
      .join('\n');
    expect(sql).not.toMatch(/\buuidv7\s*\(/i);
    expect(sql).not.toMatch(/WITHOUT OVERLAPS/i);
    expect(sql).not.toMatch(/\bVIRTUAL\b/i);
    expect(sql).not.toMatch(/\bMAINTAIN\b/i);
    // Colunas geradas precisam ser STORED (o PG18 passou a usar VIRTUAL como padrão).
    const generatedColumns = sql.split('\n').filter((line) => line.includes('GENERATED ALWAYS AS'));
    expect(generatedColumns.length).toBeGreaterThan(0);
    for (const line of generatedColumns) {
      expect(line).toMatch(/\) STORED\b/);
    }
  });

  it('nenhuma migração concede TRUNCATE/REFERENCES/TRIGGER/ALL nem desliga RLS', () => {
    const sql = loadMigrations()
      .flatMap((migration) => migration.statements)
      .join('\n')
      .replaceAll(/--[^\n]*/g, '');
    expect(sql).not.toMatch(/GRANT\s+ALL\b/i);
    expect(sql).not.toMatch(/GRANT[^;]*\b(TRUNCATE|REFERENCES|TRIGGER)\b/i);
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i);
    // Papéis só nascem/são alterados com NOSUPERUSER/NOBYPASSRLS.
    expect(sql).not.toMatch(/(CREATE|ALTER)\s+ROLE[^;]*?(?<!NO)(SUPERUSER|BYPASSRLS)\b/i);
  });

  it('o hash fixado da função de invariantes é o do corpo definido pela última migração que a cria', () => {
    const definitions = loadMigrations()
      .flatMap((migration) => migration.statements)
      .flatMap((statement) => [
        ...statement.matchAll(
          /CREATE (?:OR REPLACE )?FUNCTION app_private\.assert_security_invariants\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$/g,
        ),
      ])
      .map((match) => match[1] ?? '');
    expect(definitions.length).toBeGreaterThan(0);
    const body = definitions.at(-1) ?? '';
    // Se falhar depois de mudar a função numa migração: atualize INVARIANTS_FUNCTION_SHA256.
    expect(createHash('sha256').update(body).digest('hex')).toBe(INVARIANTS_FUNCTION_SHA256);
  });

  it('recusa journal fora de ordem', () => {
    const folder = copyWithJournal((journal) => {
      const [first, second] = journal.entries;
      if (first !== undefined && second !== undefined) {
        second.when = first.when;
      }
    });
    expect(() => loadMigrations(folder)).toThrow(MigrationIntegrityError);
  });

  it('recusa tag com caracteres fora do padrão (evita path traversal)', () => {
    const folder = copyWithJournal((journal) => {
      const [first] = journal.entries;
      if (first !== undefined) {
        first.tag = '../../etc/passwd';
      }
    });
    expect(() => loadMigrations(folder)).toThrow(MigrationIntegrityError);
  });
});
