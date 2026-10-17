#!/usr/bin/env node
// @ts-check
/**
 * PostToolUse(Edit|Write|MultiEdit): formata e linta SÓ o arquivo editado.
 *
 * - Biome (`biome check --write`) em qualquer arquivo que o Biome do projeto conheça.
 * - ESLint (`--fix --max-warnings=0`) só onde o `pnpm lint` do repositório aplica ESLint:
 *   arquivos TS/JS de um pacote com eslint.config.mjs próprio (apps/*, packages/*) e
 *   arquivos *.{js,mjs,cjs} na raiz.
 * Problemas que sobram => exit 2 com o relatório no stderr (o Claude vê e corrige).
 * Sem os binários instalados, ou fora do projeto, não faz nada.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { readHookInput } from './lib/hook-io.mjs';

const LINT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED_DIRS =
  /(^|\/)(?:node_modules|dist|build|out|\.next|\.turbo|coverage|\.git|playwright-report|test-results)\//;
const OUTPUT_LIMIT = 6000;
const TOOL_TIMEOUT_MS = 90_000;

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string | null} saída quando o comando falha; null quando passa
 */
function run(bin, args, cwd) {
  try {
    execFileSync(bin, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TOOL_TIMEOUT_MS,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return null;
  } catch (error) {
    const e = /** @type {{ stdout?: string, stderr?: string, message?: string }} */ (error);
    return `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || String(e.message ?? error);
  }
}

/**
 * Diretório do pacote cujo eslint.config.mjs cobre o arquivo, ou null.
 * @param {string} file absoluto
 * @param {string} root raiz do projeto
 * @returns {string | null}
 */
function eslintScope(file, root) {
  if (!LINT_EXTENSIONS.has(path.extname(file))) return null;
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (!rel.includes('/')) return /\.(?:js|mjs|cjs)$/.test(rel) ? root : null;
  let dir = path.dirname(file);
  while (dir.startsWith(root) && dir !== root) {
    if (
      existsSync(path.join(dir, 'eslint.config.mjs')) &&
      existsSync(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function main() {
  const input = readHookInput();
  const toolInput = input.tool_input ?? {};
  const file = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  if (file === '' || !existsSync(file)) return 0;
  const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || IGNORED_DIRS.test(`${rel}`))
    return 0;

  /** @type {string[]} */
  const problems = [];
  const biome = path.join(root, 'node_modules', '.bin', 'biome');
  if (existsSync(biome)) {
    const out = run(
      biome,
      ['check', '--write', '--no-errors-on-unmatched', '--files-ignore-unknown=true', abs],
      root,
    );
    if (out) problems.push(`biome check:\n${out}`);
  }

  const scope = eslintScope(abs, root);
  const eslint = path.join(root, 'node_modules', '.bin', 'eslint');
  if (scope && existsSync(eslint)) {
    const out = run(eslint, ['--fix', '--max-warnings=0', '--no-warn-ignored', abs], scope);
    if (out) problems.push(`eslint (${path.relative(root, scope) || '.'}):\n${out}`);
  }

  if (problems.length === 0) return 0;
  process.stderr.write(
    `[post-edit-quality] Corrija antes de seguir (${rel}):\n${problems.join('\n\n').slice(0, OUTPUT_LIMIT)}\n`,
  );
  return 2;
}

try {
  process.exitCode = main();
} catch (error) {
  // Hook de qualidade: falha interna não bloqueia, mas fica visível.
  process.stderr.write(
    `[post-edit-quality] erro interno: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
