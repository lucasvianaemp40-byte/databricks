// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fakeBin, runHook, tempDir, writeFiles } from '../test-support/helpers.mjs';

/**
 * Projeto falso + PATH com pnpm/corepack falsos que registram as chamadas.
 * @param {import('node:test').TestContext} t
 */
function setup(t) {
  const base = tempDir(t, 'session');
  const dir = path.join(base, 'proj');
  const bin = path.join(base, 'bin');
  const tmp = path.join(base, 'tmp');
  const log = path.join(base, 'calls.log');
  writeFiles(dir, {
    'package.json': '{"name":"root","private":true}\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'pnpm-workspace.yaml': 'packages: []\n',
    'apps/web/package.json': '{"name":"@salon/web"}\n',
  });
  writeFiles(tmp, { '.keep': '' });
  fakeBin(path.join(bin, 'corepack'), `echo "corepack $*" >> "${log}"`);
  fakeBin(
    path.join(bin, 'pnpm'),
    [
      'if [ "$1" = "--version" ]; then echo 11.28.5; exit 0; fi',
      `echo "pnpm $*" >> "${log}"`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sintaxe de shell
      'if [ "${FAKE_PNPM_FAIL:-}" = 1 ]; then echo "ERR_PNPM_OUTDATED_LOCKFILE" >&2; exit 1; fi',
      'mkdir -p node_modules/.pnpm',
    ].join('\n'),
  );
  /** @param {Record<string, string>} [env] */
  const run = (env = {}) =>
    runHook(
      'session-start.sh',
      { hook_event_name: 'SessionStart', source: 'startup', cwd: dir },
      {
        cwd: dir,
        env: {
          CLAUDE_PROJECT_DIR: dir,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          TMPDIR: tmp,
          ...env,
        },
      },
    );
  const calls = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { dir, run, calls };
}

const REMOTE = { CLAUDE_CODE_REMOTE: 'true' };

describe('session-start.sh', () => {
  it('fora da nuvem não faz nada', (t) => {
    const { run, calls } = setup(t);
    const r = run();
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(calls(), []);
  });

  it('na nuvem ativa o pnpm e instala com lockfile congelado', (t) => {
    const { run, calls } = setup(t);
    const r = run(REMOTE);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Dependências instaladas/);
    assert.deepEqual(calls(), [
      'corepack enable pnpm',
      'pnpm install --frozen-lockfile --prefer-offline',
    ]);
  });

  it('usa o cache: segunda sessão com o mesmo lockfile não reinstala', (t) => {
    const { run, calls } = setup(t);
    run(REMOTE);
    const r = run(REMOTE);
    assert.match(r.stdout, /Dependências em dia/);
    assert.equal(calls().filter((c) => c.startsWith('pnpm install')).length, 1);
  });

  it('lockfile alterado invalida o cache', (t) => {
    const { dir, run, calls } = setup(t);
    run(REMOTE);
    writeFiles(dir, { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# mudou\n" });
    run(REMOTE);
    assert.equal(calls().filter((c) => c.startsWith('pnpm install')).length, 2);
  });

  it('falha de instalação vira aviso e nunca derruba a sessão', (t) => {
    const { dir, run } = setup(t);
    const r = run({ ...REMOTE, FAKE_PNPM_FAIL: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /AVISO\(session-start\)/);
    assert.equal(
      existsSync(path.join(dir, 'node_modules', '.cache', 'claude-session-install.sha256')),
      false,
    );
  });

  it('diretório sem package.json: sai em silêncio', (t) => {
    const { dir, run, calls } = setup(t);
    const r = run({ ...REMOTE, CLAUDE_PROJECT_DIR: path.join(dir, 'apps') });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(calls(), []);
  });
});
