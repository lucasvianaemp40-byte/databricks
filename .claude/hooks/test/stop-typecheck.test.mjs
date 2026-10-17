// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fakeBin, git, initRepo, runHook, tempDir, writeFiles } from '../test-support/helpers.mjs';

/**
 * Monorepo falso com turbo substituído por um script que registra os argumentos.
 * @param {import('node:test').TestContext} t
 */
function setup(t) {
  const dir = tempDir(t, 'stop');
  // Dentro de node_modules/ (ignorado pelo git) para não contar como mudança.
  const log = path.join(dir, 'node_modules', 'turbo-calls.log');
  initRepo(dir, {
    'package.json': '{"name":"root","private":true}\n',
    '.gitignore': 'node_modules/\n',
    'packages/core/package.json': '{"name":"@salon/scheduling-core"}\n',
    'packages/core/src/index.ts': 'export const a = 1;\n',
    'packages/db/package.json': '{"name":"@salon/db"}\n',
    'packages/db/src/index.ts': 'export const b = 1;\n',
    'docs/README.md': '# docs\n',
  });
  fakeBin(
    path.join(dir, 'node_modules', '.bin', 'turbo'),
    `echo "$*" >> "${log}"\nif [ "\${FAKE_TURBO_FAIL:-}" = 1 ]; then echo "src/index.ts(1,1): error TS2322: tipo errado"; exit 1; fi\nexit 0`,
  );
  /**
   * @param {Record<string, unknown>} [extra]
   * @param {Record<string, string>} [env]
   */
  const run = (extra = {}, env = {}) =>
    runHook(
      'stop-typecheck.mjs',
      { hook_event_name: 'Stop', stop_hook_active: false, cwd: dir, ...extra },
      { env: { CLAUDE_PROJECT_DIR: dir, ...env }, cwd: dir },
    );
  const calls = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { dir, run, calls };
}

describe('stop-typecheck', () => {
  it('sem mudanças de código, não roda nada', (t) => {
    const { dir, run, calls } = setup(t);
    writeFiles(dir, { 'docs/README.md': '# docs alterado\n' });
    const r = run();
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.deepEqual(calls(), []);
  });

  it('filtra pelo pacote alterado e seus dependentes', (t) => {
    const { dir, run, calls } = setup(t);
    writeFiles(dir, { 'packages/core/src/index.ts': 'export const a = 2;\n' });
    assert.equal(run().status, 0);
    assert.deepEqual(calls(), [
      'run typecheck --filter=...@salon/scheduling-core --output-logs=errors-only',
    ]);
  });

  it('arquivo novo não rastreado também conta', (t) => {
    const { dir, run, calls } = setup(t);
    writeFiles(dir, { 'packages/db/src/novo.ts': 'export {};\n' });
    run();
    assert.deepEqual(calls(), ['run typecheck --filter=...@salon/db --output-logs=errors-only']);
  });

  it('mudança de configuração na raiz checa todos os pacotes', (t) => {
    const { dir, run, calls } = setup(t);
    writeFiles(dir, { 'package.json': '{"name":"root","private":true,"x":1}\n' });
    run();
    assert.deepEqual(calls(), ['run typecheck --output-logs=errors-only']);
  });

  it('renomeação é tratada (pacote de destino)', (t) => {
    const { dir, run, calls } = setup(t);
    git(dir, ['mv', 'packages/db/src/index.ts', 'packages/db/src/main.ts']);
    run();
    assert.deepEqual(calls(), ['run typecheck --filter=...@salon/db --output-logs=errors-only']);
  });

  it('erro de tipo bloqueia o encerramento com o final da saída', (t) => {
    const { dir, run } = setup(t);
    writeFiles(dir, { 'packages/core/src/index.ts': 'export const a: string = 2;\n' });
    const r = run({}, { FAKE_TURBO_FAIL: '1' });
    assert.equal(r.status, 0);
    assert.equal(r.json?.decision, 'block');
    assert.match(r.json?.reason, /\[stop-typecheck\]/);
    assert.match(r.json?.reason, /TS2322/);
  });

  it('respeita stop_hook_active (não bloqueia de novo)', (t) => {
    const { dir, run, calls } = setup(t);
    writeFiles(dir, { 'packages/core/src/index.ts': 'export const a: string = 2;\n' });
    const r = run({ stop_hook_active: true }, { FAKE_TURBO_FAIL: '1' });
    assert.equal(r.stdout.trim(), '');
    assert.deepEqual(calls(), []);
  });

  it('erro interno não bloqueia (exit 1)', () => {
    const r = runHook('stop-typecheck.mjs', '{ quebrado');
    assert.equal(r.status, 1);
    assert.equal(r.stdout.trim(), '');
  });
});
