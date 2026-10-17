// @ts-check
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { evaluateFileTool } from '../lib/files-policy.mjs';
import { git, initRepo, runHook, tempDir, writeFiles } from '../test-support/helpers.mjs';

const ROOT = '/repo';

/**
 * @param {Partial<import('../lib/files-policy.mjs').FilesContext>} [overrides]
 * @returns {import('../lib/files-policy.mjs').FilesContext}
 */
function ctx(overrides = {}) {
  return {
    cwd: ROOT,
    projectDir: ROOT,
    existsOnDefaultBranch: () => ({ exists: false, ref: null, rel: null }),
    ...overrides,
  };
}

/**
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {Partial<import('../lib/files-policy.mjs').FilesContext>} [overrides]
 */
function decisionOf(tool, input, overrides) {
  return evaluateFileTool(tool, input, ctx(overrides)).decision ?? 'none';
}

describe('segredos', () => {
  const cases = /** @type {Array<[string, Record<string, unknown>, string]>} */ ([
    ['Read', { file_path: '/repo/.env' }, 'deny'],
    ['Read', { file_path: '/repo/apps/web/.env.local' }, 'deny'],
    ['Read', { file_path: '/repo/.env.production' }, 'deny'],
    ['Read', { file_path: '/home/u/.ssh/id_rsa' }, 'deny'],
    ['Read', { file_path: '/home/u/.aws/credentials' }, 'deny'],
    ['Read', { file_path: '/repo/certs/server.key' }, 'deny'],
    ['Edit', { file_path: '/repo/.env', old_string: 'a', new_string: 'b' }, 'deny'],
    ['Write', { file_path: '/repo/.env.local', content: 'X=1' }, 'deny'],
    ['MultiEdit', { file_path: '/repo/x.ts', edits: [{ file_path: '/repo/.env' }] }, 'deny'],
    ['NotebookEdit', { notebook_path: '/repo/.env' }, 'deny'],
    ['Grep', { pattern: 'KEY', path: '/repo/.env' }, 'deny'],
    ['Grep', { pattern: 'KEY', glob: '.env*' }, 'deny'],
    ['Grep', { pattern: 'KEY', glob: '*.pem' }, 'deny'],
    ['Read', { file_path: '/repo/.env.example' }, 'none'],
    ['Edit', { file_path: '/repo/.env.example', old_string: 'a', new_string: 'b' }, 'none'],
    ['Read', { file_path: '/repo/packages/db/src/env.ts' }, 'none'],
    ['Grep', { pattern: 'withTenant', path: '/repo/packages', glob: '*.ts' }, 'none'],
    ['Read', { file_path: 'relativo/.env' }, 'deny'],
  ]);
  for (const [tool, input, expected] of cases) {
    it(`${expected} ${tool} ${JSON.stringify(input)}`, () => {
      assert.equal(decisionOf(tool, input), expected);
    });
  }
});

describe('lockfiles e migrações', () => {
  it('nega editar pnpm-lock.yaml à mão, mas permite ler', () => {
    assert.equal(decisionOf('Edit', { file_path: '/repo/pnpm-lock.yaml' }), 'deny');
    assert.equal(decisionOf('Write', { file_path: '/repo/pnpm-lock.yaml' }), 'deny');
    assert.equal(decisionOf('Read', { file_path: '/repo/pnpm-lock.yaml' }), 'none');
  });

  it('nega editar migração publicada e permite migração nova', () => {
    const published = () => ({ exists: true, ref: 'origin/main', rel: 'x' });
    const file = '/repo/packages/db/drizzle/0001_rls.sql';
    assert.equal(
      decisionOf('Edit', { file_path: file }, { existsOnDefaultBranch: published }),
      'deny',
    );
    assert.equal(
      decisionOf('Read', { file_path: file }, { existsOnDefaultBranch: published }),
      'none',
    );
    assert.equal(decisionOf('Write', { file_path: file }), 'none');
  });

  it('pede confirmação para editar _journal.json à mão', () => {
    assert.equal(
      decisionOf('Edit', { file_path: '/repo/packages/db/drizzle/meta/_journal.json' }),
      'ask',
    );
  });

  it('ignora migrações fora do projeto', () => {
    const published = () => ({ exists: true, ref: 'origin/main', rel: 'x' });
    assert.equal(
      decisionOf(
        'Edit',
        { file_path: '/outro/drizzle/0001.sql' },
        { existsOnDefaultBranch: published },
      ),
      'none',
    );
  });
});

describe('hook guard-files.mjs (processo real, repositório temporário)', () => {
  /**
   * @param {string} dir
   * @param {string} tool
   * @param {Record<string, unknown>} toolInput
   */
  function run(dir, tool, toolInput) {
    const r = runHook(
      'guard-files.mjs',
      { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd: dir },
      { env: { CLAUDE_PROJECT_DIR: dir }, cwd: dir },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.json?.hookSpecificOutput?.permissionDecision ?? 'none';
  }

  it('migração na branch padrão é imutável; a nova é livre', (t) => {
    const dir = tempDir(t, 'files-migration');
    initRepo(dir, {
      'packages/db/drizzle/0000_init.sql': 'create table x (id int);\n',
      'packages/db/drizzle/meta/0000_snapshot.json': '{}\n',
    });
    git(dir, ['checkout', '--quiet', '-b', 'claude/feature']);
    writeFiles(dir, { 'packages/db/drizzle/0001_new.sql': 'select 1;\n' });
    const sql = path.join(dir, 'packages/db/drizzle/0000_init.sql');
    const snapshot = path.join(dir, 'packages/db/drizzle/meta/0000_snapshot.json');
    assert.equal(run(dir, 'Edit', { file_path: sql, old_string: 'x', new_string: 'y' }), 'deny');
    assert.equal(run(dir, 'Write', { file_path: snapshot, content: '{}' }), 'deny');
    assert.equal(run(dir, 'Read', { file_path: sql }), 'none');
    const fresh = path.join(dir, 'packages/db/drizzle/0001_new.sql');
    assert.equal(run(dir, 'Edit', { file_path: fresh, old_string: '1', new_string: '2' }), 'none');
  });

  it('link simbólico para .env não contorna a regra', (t) => {
    const dir = tempDir(t, 'files-symlink');
    initRepo(dir, { 'README.md': '# x\n' });
    writeFiles(dir, { '.env': 'X=1\n' });
    symlinkSync(path.join(dir, '.env'), path.join(dir, 'config.txt'));
    assert.equal(run(dir, 'Read', { file_path: path.join(dir, 'config.txt') }), 'deny');
  });

  it('é fail-closed com JSON inválido', () => {
    const r = runHook('guard-files.mjs', 'nao-json');
    assert.equal(r.status, 0);
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'deny');
  });

  it('não emite nada para leitura comum', (t) => {
    const dir = tempDir(t, 'files-plain');
    initRepo(dir, { 'src/a.ts': 'export {};\n' });
    assert.equal(run(dir, 'Read', { file_path: path.join(dir, 'src/a.ts') }), 'none');
  });
});
