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
    // O Grep separa a lista por vírgula/espaço e expande chaves: cada parte é um glob.
    ['Grep', { pattern: 'KEY', glob: '{.env,x}' }, 'deny'],
    ['Grep', { pattern: 'KEY', glob: '{.env,.env.local}' }, 'deny'],
    ['Grep', { pattern: 'KEY', glob: '.gitignore,.env' }, 'deny'],
    ['Grep', { pattern: 'KEY', glob: '.gitignore .env' }, 'deny'],
    ['Grep', { pattern: 'KEY', glob: '**/{.env,a}' }, 'deny'],
    ['Grep', { pattern: 'KEY', glob: '.env{,.local}' }, 'deny'],
    ['Grep', { pattern: 'KEY', glob: '[.]env' }, 'deny'],
    ['Grep', { pattern: 'KEY', glob: 'cred*.json' }, 'deny'],
    ['Grep', { pattern: 'KEY', glob: '*.json' }, 'none'],
    ['Grep', { pattern: 'KEY', glob: '**/*.json' }, 'none'],
    ['Grep', { pattern: 'KEY', glob: '*.{ts,json}' }, 'none'],
    ['Grep', { pattern: 'KEY', glob: '*' }, 'none'],
    ['Grep', { pattern: 'KEY', glob: '.*' }, 'none'],
    ['Read', { file_path: '/root/.bash_history' }, 'deny'],
    ['Read', { file_path: '/root/.claude.json' }, 'deny'],
    ['Read', { file_path: '/root/.claude/projects/-repo/abc.jsonl' }, 'deny'],
    ['Read', { file_path: '/root/.claude/session-env/abc/hook-0.sh' }, 'deny'],
    ['Read', { file_path: '/root/.gitconfig' }, 'none'],
    ['Read', { file_path: '/root/.claude/projects/-repo/memory/MEMORY.md' }, 'none'],
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

  it('pede confirmação para escrever configuração de hooks git e do MCP', () => {
    for (const file of [
      '/repo/.lefthook-local.yml',
      '/repo/lefthook-local.toml',
      '/repo/.config/lefthook-local.yml',
      '/repo/lefthook.yml',
      '/repo/.git/hooks/pre-commit',
      '/repo/.git/config',
      '/repo/.mcp.json',
      '/repo/.claude/mcp/playwright-mcp.sh',
    ]) {
      assert.equal(decisionOf('Write', { file_path: file, content: 'x' }), 'ask', file);
    }
    assert.equal(decisionOf('Read', { file_path: '/repo/.lefthook-local.yml' }), 'none');
    assert.equal(decisionOf('Write', { file_path: '/repo/src/lefthook.ts', content: 'x' }), 'none');
  });
});

describe('dica de exclusão de cobertura (regra 3: o piso de cobertura não se contorna)', () => {
  it('pede confirmação ao adicionar a dica em src/, test/ ou e2e/ de um pacote', () => {
    const cases = /** @type {Array<[string, Record<string, unknown>]>} */ ([
      ['Write', { file_path: '/repo/packages/db/src/x.ts', content: '/* v8 ignore next */\nx();' }],
      [
        'Edit',
        {
          file_path: '/repo/packages/scheduling-core/src/a.ts',
          old_string: 'x();',
          new_string: '/* istanbul ignore next */\nx();',
        },
      ],
      [
        'Edit',
        {
          file_path: '/repo/apps/web/src/app/page.tsx',
          old_string: 'a',
          new_string: '// c8 ignore start',
        },
      ],
      [
        'MultiEdit',
        {
          file_path: '/repo/apps/web/e2e/x.spec.ts',
          edits: [{ old_string: 'a', new_string: '/* node:coverage disable */' }],
        },
      ],
      [
        'Write',
        { file_path: '/repo/packages/db/test/x.test.ts', content: '/* C8 IGNORE next 3 */' },
      ],
    ]);
    for (const [tool, input] of cases) {
      assert.equal(decisionOf(tool, input), 'ask', JSON.stringify(input));
    }
  });

  it('não pede confirmação sem dica nova, fora dos pacotes ou quando só move a dica', () => {
    const cases = /** @type {Array<[string, Record<string, unknown>]>} */ ([
      ['Write', { file_path: '/repo/packages/db/src/x.ts', content: 'export const x = 1;\n' }],
      ['Write', { file_path: '/repo/docs/qa/estrategia.md', content: 'proibido: v8 ignore' }],
      // Fora de src/test/e2e de um pacote. (.claude/hooks/ pede confirmação por outro motivo:
      // é configuração protegida do agente; ver o describe próprio abaixo.)
      ['Write', { file_path: '/repo/scripts/x.mjs', content: '// v8 ignore next' }],
      [
        'Edit',
        {
          file_path: '/repo/packages/db/src/x.ts',
          old_string: '/* v8 ignore next */\nx();',
          new_string: '/* v8 ignore next */\ny();',
        },
      ],
      ['Read', { file_path: '/repo/packages/db/src/x.ts' }],
    ]);
    for (const [tool, input] of cases) {
      assert.equal(decisionOf(tool, input), 'none', JSON.stringify(input));
    }
  });
});

describe('configuração protegida do agente (settings e hooks do Claude Code)', () => {
  // Na nuvem as ferramentas de arquivo rodam sem pedir aprovação em qualquer modo, então a
  // regra nativa `permissions.ask` não protege; o hook pede a confirmação (ask, não deny: o
  // kit precisa continuar mantível por um humano).
  const HOME = process.env.HOME ?? '/root';
  const protectedFiles = [
    '/repo/.claude/settings.json',
    '/repo/.claude/settings.local.json',
    '/repo/.claude/hooks/guard-bash.mjs',
    '/repo/.claude/hooks/lib/bash-policy.mjs',
    '/repo/.claude/hooks/test/x.test.mjs',
    `${HOME}/.claude/settings.json`,
    `${HOME}/.claude/settings.local.json`,
  ];

  it('pede confirmação para Edit, Write, MultiEdit e NotebookEdit', () => {
    for (const file of protectedFiles) {
      assert.equal(
        decisionOf('Edit', { file_path: file, old_string: 'a', new_string: 'b' }),
        'ask',
        file,
      );
      assert.equal(decisionOf('Write', { file_path: file, content: '{}' }), 'ask', file);
      assert.equal(
        decisionOf('MultiEdit', { file_path: file, edits: [{ old_string: 'a', new_string: 'b' }] }),
        'ask',
        file,
      );
      assert.equal(
        decisionOf('NotebookEdit', { notebook_path: file, new_source: 'x' }),
        'ask',
        file,
      );
    }
  });

  it('o motivo cita o caminho e a aprovação humana', () => {
    const r = evaluateFileTool('Edit', { file_path: '/repo/.claude/settings.json' }, ctx());
    assert.equal(r.decision, 'ask');
    assert.match(r.reasons.join(' '), /\.claude\/settings\.json/);
    assert.match(r.reasons.join(' '), /aprova/);
  });

  it('caminho relativo e MultiEdit com arquivo protegido em edits também pedem', () => {
    assert.equal(
      decisionOf('Write', { file_path: '.claude/hooks/guard-files.mjs', content: '' }),
      'ask',
    );
    assert.equal(
      decisionOf('MultiEdit', {
        file_path: '/repo/README.md',
        edits: [{ file_path: '/repo/.claude/settings.json', old_string: 'a', new_string: 'b' }],
      }),
      'ask',
    );
  });

  it('não pede para ler nem para o resto de .claude/', () => {
    assert.equal(decisionOf('Read', { file_path: '/repo/.claude/settings.json' }), 'none');
    assert.equal(decisionOf('Read', { file_path: '/repo/.claude/hooks/guard-bash.mjs' }), 'none');
    assert.equal(decisionOf('Grep', { pattern: 'x', path: '/repo/.claude/hooks' }), 'none');
    for (const file of [
      '/repo/.claude/README.md',
      '/repo/.claude/skills/verify/SKILL.md',
      '/repo/.claude/agents/qa-engineer.md',
      '/repo/.claude/rules/web-server.md',
      '/repo/.claude/settings.json.bak',
      '/repo/.claude/hooks-notes.md',
      '/repo/docs/hooks/settings.json',
    ]) {
      assert.equal(decisionOf('Write', { file_path: file, content: 'x' }), 'none', file);
    }
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

  it('Edit em .claude/settings.json e .claude/hooks/ pede confirmação no hook real', (t) => {
    const dir = tempDir(t, 'files-agent-config');
    initRepo(dir, {
      '.claude/settings.json': '{}\n',
      '.claude/hooks/guard-bash.mjs': '// guard\n',
    });
    const settings = path.join(dir, '.claude/settings.json');
    const guard = path.join(dir, '.claude/hooks/guard-bash.mjs');
    assert.equal(
      run(dir, 'Edit', { file_path: settings, old_string: '{}', new_string: '[]' }),
      'ask',
    );
    assert.equal(run(dir, 'Write', { file_path: guard, content: 'process.exit(0)\n' }), 'ask');
    assert.equal(run(dir, 'Read', { file_path: guard }), 'none');
  });

  it('não emite nada para leitura comum', (t) => {
    const dir = tempDir(t, 'files-plain');
    initRepo(dir, { 'src/a.ts': 'export {};\n' });
    assert.equal(run(dir, 'Read', { file_path: path.join(dir, 'src/a.ts') }), 'none');
  });
});
