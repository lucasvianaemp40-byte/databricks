// @ts-check
/**
 * Utilitários dos testes dos hooks. Fica FORA de test/ porque `pnpm test:hooks` executa
 * todo arquivo JS daquele diretório como teste.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = fileURLToPath(new URL('..', import.meta.url));
export const PROJECT_ROOT = path.resolve(HOOKS_DIR, '..', '..');

/**
 * Ambiente limpo para subprocessos: sem CLAUDE_* herdados da sessão que roda os testes.
 * @param {Record<string, string | undefined>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
function cleanEnv(extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CLAUDE_') || key.startsWith('GIT_')) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Executa um hook como o Claude Code faria (JSON no stdin).
 * @param {string} script caminho relativo a .claude/hooks (ex.: 'guard-bash.mjs')
 * @param {unknown} input objeto (serializado) ou string crua
 * @param {{ env?: Record<string, string | undefined>, cwd?: string, timeout?: number }} [options]
 */
export function runHook(script, input, options = {}) {
  const file = path.join(HOOKS_DIR, script);
  const isShell = script.endsWith('.sh');
  const result = spawnSync(isShell ? 'bash' : process.execPath, [file], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: options.cwd ?? PROJECT_ROOT,
    env: cleanEnv(options.env),
    timeout: options.timeout ?? 30_000,
  });
  const stdout = result.stdout ?? '';
  let json = null;
  if (stdout.trim().startsWith('{')) json = JSON.parse(stdout);
  return { status: result.status, stdout, stderr: result.stderr ?? '', json };
}

/**
 * Diretório temporário removido no fim do teste.
 * @param {{ after: (fn: () => void) => void }} t contexto do node:test
 * @param {string} prefix
 */
export function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `claude-hooks-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanEnv({
      GIT_AUTHOR_NAME: 'Teste',
      GIT_AUTHOR_EMAIL: 'teste@example.invalid',
      GIT_COMMITTER_NAME: 'Teste',
      GIT_COMMITTER_EMAIL: 'teste@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Cria um repositório git com branch padrão `main` e um commit com `files`.
 * @param {string} dir
 * @param {Record<string, string>} files caminho relativo -> conteúdo
 */
export function initRepo(dir, files) {
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  writeFiles(dir, files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '--no-gpg-sign', '-m', 'inicial']);
}

/**
 * @param {string} dir
 * @param {Record<string, string>} files
 */
export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/**
 * Cria um executável falso (script sh) — usado no lugar de biome/eslint/turbo/pnpm.
 * @param {string} file
 * @param {string} body corpo do script sh
 */
export function fakeBin(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/**
 * Monta um "segredo" de teste em tempo de execução, para que o código-fonte dos testes
 * não contenha strings que scanners (gitleaks, Biome noSecrets) tratariam como reais.
 * @param {...string} parts
 */
export function joinSecret(...parts) {
  return parts.join('');
}
