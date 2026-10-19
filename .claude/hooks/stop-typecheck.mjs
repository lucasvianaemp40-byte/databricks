#!/usr/bin/env node
// @ts-check
/**
 * Stop: se o turno deixou arquivos TS/JS (ou tsconfig/package.json) alterados, roda o
 * typecheck SÓ dos pacotes afetados e dos que dependem deles, via turbo (com cache).
 *   - arquivo em packages/x ou apps/x  -> `turbo run typecheck --filter=...<nome do pacote>`
 *   - arquivo de configuração na raiz  -> todos os pacotes
 *   - .claude/, docs/ etc.             -> nada (não fazem parte de um projeto TS)
 * Falhou => `{"decision":"block"}` com as últimas linhas, e o Claude continua para corrigir.
 * Respeita `stop_hook_active`: na segunda parada seguida não bloqueia de novo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { readHookInput } from './lib/hook-io.mjs';

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const CONFIG_FILE = /(?:^|\/)(?:package\.json|tsconfig[\w.-]*\.json)$/;
const ROOT_WIDE =
  /^(?:tsconfig\.base\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json)$/;
const MAX_LINES = 80;

/**
 * Arquivos alterados no working tree (inclui não rastreados e removidos).
 * @param {string} root
 * @returns {string[] | null}
 */
function changedFiles(root) {
  let out;
  try {
    out = execFileSync(
      'git',
      ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      },
    );
  } catch {
    return null;
  }
  /** @type {string[]} */
  const files = [];
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? '';
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    // Renomeação/cópia: o caminho de origem vem na entrada seguinte.
    if (status.includes('R') || status.includes('C')) i++;
  }
  return files;
}

/**
 * Nome do pacote do workspace que contém `rel`, '*' para mudanças na raiz que afetam
 * todos, ou null quando o arquivo não pertence a nenhum projeto TS.
 * @param {string} root
 * @param {string} rel
 * @returns {string | null}
 */
function owningPackage(root, rel) {
  if (ROOT_WIDE.test(rel)) return '*';
  if (!rel.includes('/')) return null;
  let dir = path.dirname(path.join(root, rel));
  while (dir.startsWith(root) && dir !== root) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = JSON.parse(readFileSync(pkg, 'utf8')).name;
        return typeof name === 'string' && name !== '' ? name : null;
      } catch {
        return null;
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

function main() {
  const input = readHookInput();
  if (input.stop_hook_active === true) return;
  const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const files = changedFiles(root);
  if (!files) return;
  const relevant = files.filter(
    (f) => CODE_FILE.test(f) || CONFIG_FILE.test(f) || ROOT_WIDE.test(f),
  );
  if (relevant.length === 0) return;

  /** @type {Set<string>} */
  const packages = new Set();
  for (const rel of relevant) {
    const owner = owningPackage(root, rel);
    if (owner) packages.add(owner);
  }
  if (packages.size === 0) return;

  const turbo = path.join(root, 'node_modules', '.bin', 'turbo');
  if (!existsSync(turbo)) return;
  const filters = packages.has('*')
    ? []
    : [...packages].sort().map((name) => `--filter=...${name}`);
  const args = ['run', 'typecheck', ...filters, '--output-logs=errors-only'];
  try {
    execFileSync(turbo, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240_000,
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
  } catch (error) {
    const e =
      /** @type {{ stdout?: string, stderr?: string, message?: string, signal?: string }} */ (
        error
      );
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || String(e.message ?? error);
    const tail = output.split('\n').slice(-MAX_LINES).join('\n');
    process.stdout.write(
      `${JSON.stringify({
        decision: 'block',
        reason: `[stop-typecheck] \`turbo ${args.join(' ')}\` falhou${e.signal ? ` (${e.signal})` : ''}. Corrija os erros de tipo antes de encerrar, ou explique ao usuário por que não é possível:\n${tail}`,
      })}\n`,
    );
  }
}

try {
  main();
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(
    `[stop-typecheck] erro interno: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
