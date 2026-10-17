// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fakeBin, runHook, tempDir, writeFiles } from '../test-support/helpers.mjs';

/**
 * Projeto falso com biome/eslint substituídos por scripts que registram a chamada.
 * @param {import('node:test').TestContext} t
 */
function setup(t) {
  const dir = tempDir(t, 'quality');
  const log = path.join(dir, 'calls.log');
  writeFiles(dir, {
    'package.json': '{"name":"root","private":true}\n',
    'eslint.config.mjs': 'export default [];\n',
    'apps/web/package.json': '{"name":"@salon/web"}\n',
    'apps/web/eslint.config.mjs': 'export default [];\n',
    'apps/web/src/page.tsx': 'export default function Page() { return null; }\n',
    'apps/web/README.md': '# web\n',
    'tools.mjs': 'export {};\n',
    'node_modules/pkg/index.js': 'module.exports = 1;\n',
  });
  for (const name of ['biome', 'eslint']) {
    const upper = name.toUpperCase();
    fakeBin(
      path.join(dir, 'node_modules', '.bin', name),
      `echo "${name}|$(pwd)|$*" >> "${log}"\nif [ "\${FAKE_${upper}_FAIL:-}" = 1 ]; then echo "${name}: problema em $*"; exit 1; fi\nexit 0`,
    );
  }
  /**
   * @param {string} rel
   * @param {Record<string, string>} [env]
   */
  const run = (rel, env = {}) =>
    runHook(
      'post-edit-quality.mjs',
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.isAbsolute(rel) ? rel : path.join(dir, rel) },
        cwd: dir,
      },
      { env: { CLAUDE_PROJECT_DIR: dir, ...env }, cwd: dir },
    );
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('|'))
      : [];
  return { dir, run, calls };
}

describe('post-edit-quality', () => {
  it('roda biome e eslint só no arquivo editado, com o cwd do pacote para o eslint', (t) => {
    const { dir, run, calls } = setup(t);
    const r = run('apps/web/src/page.tsx');
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(dir, 'apps/web/src/page.tsx');
    assert.deepEqual(calls(), [
      ['biome', dir, `check --write --no-errors-on-unmatched --files-ignore-unknown=true ${file}`],
      ['eslint', path.join(dir, 'apps/web'), `--fix --max-warnings=0 --no-warn-ignored ${file}`],
    ]);
  });

  it('falha de lint vira exit 2 com o relatório no stderr', (t) => {
    const { run } = setup(t);
    const r = run('apps/web/src/page.tsx', { FAKE_ESLINT_FAIL: '1' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /\[post-edit-quality\] Corrija/);
    assert.match(r.stderr, /eslint \(apps\/web\)/);
    assert.match(r.stderr, /problema em/);
  });

  it('falha do biome também bloqueia', (t) => {
    const { run } = setup(t);
    const r = run('apps/web/README.md', { FAKE_BIOME_FAIL: '1' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /biome check/);
  });

  it('arquivo sem ESLint (markdown) só passa pelo biome', (t) => {
    const { run, calls } = setup(t);
    assert.equal(run('apps/web/README.md').status, 0);
    assert.deepEqual(
      calls().map((c) => c[0]),
      ['biome'],
    );
  });

  it('JS na raiz usa o eslint da raiz', (t) => {
    const { dir, run, calls } = setup(t);
    assert.equal(run('tools.mjs').status, 0);
    assert.deepEqual(
      calls().map((c) => [c[0], c[1]]),
      [
        ['biome', dir],
        ['eslint', dir],
      ],
    );
  });

  it('ignora node_modules, arquivos fora do projeto e arquivos inexistentes', (t) => {
    const { run, calls } = setup(t);
    assert.equal(run('node_modules/pkg/index.js').status, 0);
    assert.equal(run('/etc/hostname').status, 0);
    assert.equal(run('apps/web/src/nao-existe.ts').status, 0);
    assert.deepEqual(calls(), []);
  });

  it('erro interno não bloqueia (exit 1) e aparece no stderr', () => {
    const r = runHook('post-edit-quality.mjs', '{ quebrado');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /post-edit-quality/);
  });
});
