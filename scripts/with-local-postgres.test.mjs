// @ts-check
/**
 * Testes de scripts/with-local-postgres.sh nos caminhos que terminam ANTES de subir o cluster:
 * descoberta dos binários, piso de versão e a mensagem que diz como rodar o `pnpm test:db`
 * numa máquina sem PostgreSQL. Os binários são falsos (shell); nenhum PostgreSQL é iniciado.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const script = path.join(import.meta.dirname, 'with-local-postgres.sh');

/**
 * Pasta temporária com initdb/pg_ctl/psql falsos. O initdb responde `--version` com a linha
 * dada e falha em qualquer outro uso (o script para no "initdb falhou", sem cluster).
 * @param {import('node:test').TestContext} t
 * @param {string} versionLine
 */
function fakePostgres(t, versionLine) {
  const dir = mkdtempSync(path.join(tmpdir(), 'salon-fake-pg-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (/** @type {string} */ name, /** @type {string} */ body) => {
    const file = path.join(dir, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta temporária do teste.
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- o mesmo arquivo acima.
    chmodSync(file, 0o755);
  };
  write('initdb', `if [ "$1" = "--version" ]; then echo '${versionLine}'; exit 0; fi\nexit 1`);
  write('pg_ctl', 'exit 1');
  write('psql', 'exit 1');
  return dir;
}

/** Ambiente sem banco configurado: o script precisa decidir sozinho. */
function cleanEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== 'TEST_DATABASE_URL' && !name.startsWith('PG'),
    ),
  );
  return env;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} [command]
 */
function run(env, command = ['true']) {
  const result = spawnSync(script, command, { env, encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const VERSION_GATE = /exige 16 ou mais novo|versão/;

describe('with-local-postgres.sh', () => {
  it('com TEST_DATABASE_URL, só executa o comando (CI, compose ou banco próprio)', () => {
    const r = run({ ...cleanEnv(), TEST_DATABASE_URL: 'postgresql://exemplo' }, [
      process.execPath,
      '-e',
      'process.stdout.write(process.env.TEST_DATABASE_URL ?? "")',
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'postgresql://exemplo');
  });

  it('sem binários, sai com 69 e lista as três saídas (binários, compose, URL)', () => {
    const r = run({ ...cleanEnv(), PG_BIN_DIR: path.join(tmpdir(), 'salon-nao-existe') });
    assert.equal(r.status, 69, r.stderr);
    assert.match(r.stderr, /salon-nao-existe/);
    assert.match(r.stderr, /PG_BIN_DIR/);
    assert.match(r.stderr, /brew --prefix postgresql@16/);
    assert.match(r.stderr, /docker compose up -d --wait postgres-test/);
    assert.match(r.stderr, /compose\.yaml/);
    assert.match(r.stderr, /TEST_DATABASE_URL/);
  });

  it('recusa PostgreSQL anterior ao 16 com mensagem clara', (t) => {
    const dir = fakePostgres(t, 'initdb (PostgreSQL) 15.8');
    const r = run({ ...cleanEnv(), PG_BIN_DIR: dir });
    assert.equal(r.status, 69, r.stderr);
    assert.match(r.stderr, /PostgreSQL 15/);
    assert.match(r.stderr, /exige 16 ou mais novo/);
  });

  it('recusa versão ilegível (fail-closed)', (t) => {
    const dir = fakePostgres(t, 'initdb (algum fork) sem número');
    const r = run({ ...cleanEnv(), PG_BIN_DIR: dir });
    assert.equal(r.status, 69, r.stderr);
    assert.match(r.stderr, /versão/);
  });

  for (const versionLine of [
    'initdb (PostgreSQL) 16.4',
    'initdb (PostgreSQL) 16.10 (Debian 16.10-1.pgdg120+1)',
    'initdb (PostgreSQL) 18beta1',
  ]) {
    it(`aceita "${versionLine}" e segue para o initdb`, (t) => {
      const dir = fakePostgres(t, versionLine);
      const r = run({ ...cleanEnv(), PG_BIN_DIR: dir });
      // O initdb falso falha: o script chegou depois da checagem de versão.
      assert.notEqual(r.status, 69, r.stderr);
      assert.notEqual(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, VERSION_GATE);
    });
  }

  it('acha os binários pelo PATH (Fedora, Arch, Postgres.app) antes das pastas do Debian', (t) => {
    const dir = fakePostgres(t, 'initdb (PostgreSQL) 14.12');
    const env = cleanEnv();
    const r = run({ ...env, PATH: `${dir}${path.delimiter}${env.PATH ?? ''}` });
    // A versão 14 do initdb falso prova que o script usou o PATH.
    assert.equal(r.status, 69, r.stderr);
    assert.match(r.stderr, /PostgreSQL 14/);
    assert.ok(r.stderr.includes(dir), r.stderr);
  });
});
