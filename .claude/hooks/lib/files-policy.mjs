// @ts-check
/**
 * Política do guard-files (ferramentas de arquivo do Claude Code).
 *
 * 1. Segredos: nega ler, editar ou buscar (Grep) em .env* (exceto .env.example), chaves,
 *    certificados, credenciais e diretórios de credenciais. Resolve links simbólicos, para
 *    que `atalho -> .env` não contorne a regra.
 * 2. Lockfiles: só o gerenciador de pacotes escreve (pnpm install/add/remove, sob flock).
 * 3. Migrações: uma migração que já existe na branch padrão é imutável; corrija com uma nova.
 *    O `_journal.json` do drizzle-kit não é imutável, mas edição manual pede confirmação.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { existsOnDefaultBranch as gitExistsOnDefaultBranch } from './git.mjs';
import { classifySecretPath, isLockfile, isMigrationPath } from './paths.mjs';

/**
 * @typedef {object} FilesContext
 * @property {string} cwd
 * @property {string} projectDir
 * @property {(cwd: string, absPath: string) => { exists: boolean, ref: string | null, rel: string | null }} existsOnDefaultBranch
 */

/**
 * @typedef {object} FilesResult
 * @property {'deny' | 'ask' | null} decision
 * @property {string[]} reasons
 */

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * @param {{ cwd: string, projectDir: string }} base
 * @returns {FilesContext}
 */
export function createFilesContext(base) {
  return { ...base, existsOnDefaultBranch: gitExistsOnDefaultBranch };
}

/**
 * @param {string} p
 * @returns {string | null}
 */
function realpathOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Caminhos tocados pela ferramenta.
 * @param {string} tool
 * @param {Record<string, any>} toolInput
 * @returns {string[]}
 */
function targetPaths(tool, toolInput) {
  /** @type {string[]} */
  const out = [];
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = toolInput[key];
    if (typeof value === 'string' && value !== '') out.push(value);
  }
  if (tool === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit.file_path === 'string') out.push(edit.file_path);
    }
  }
  return out;
}

/**
 * @param {string} tool
 * @param {Record<string, any>} toolInput
 * @param {FilesContext} ctx
 * @returns {FilesResult}
 */
export function evaluateFileTool(tool, toolInput, ctx) {
  /** @type {string[]} */
  const denies = [];
  /** @type {string[]} */
  const asks = [];

  if (tool === 'Grep' && typeof toolInput.glob === 'string') {
    const secret = classifySecretPath(toolInput.glob);
    if (secret) denies.push(`Busca em ${secret.reason} bloqueada.`);
  }

  for (const raw of targetPaths(tool, toolInput)) {
    const normalized = raw.replace(/\\/g, '/');
    const abs = path.resolve(ctx.cwd, normalized);
    const real = realpathOrNull(abs);
    for (const candidate of real && real !== abs ? [abs, real] : [abs]) {
      const secret = classifySecretPath(candidate);
      if (secret) {
        denies.push(
          `Arquivo sensível: ${secret.reason}. Use .env.example e a documentação; segredos ficam fora do alcance do agente.`,
        );
        break;
      }
    }
    if (!WRITE_TOOLS.has(tool)) continue;

    if (isLockfile(abs)) {
      denies.push(
        `Não edite ${path.basename(abs)} à mão; use o gerenciador de pacotes (flock ... pnpm install/add/remove).`,
      );
    }

    const target = real ?? abs;
    const rel = path.relative(ctx.projectDir, target).split(path.sep).join('/');
    const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (inside && isMigrationPath(rel)) {
      const info = ctx.existsOnDefaultBranch(ctx.projectDir, target);
      if (info.exists) {
        denies.push(
          `Migração já publicada em ${info.ref} (${info.rel ?? rel}) é imutável. Crie uma NOVA migração (forward-only) que corrija o schema.`,
        );
      }
    }
    if (inside && /(^|\/)drizzle\/meta\/_journal\.json$/.test(rel)) {
      asks.push(
        'O _journal.json é mantido pelo drizzle-kit (pnpm --filter @salon/db generate / generate:custom). Edição manual: confirme.',
      );
    }
  }

  if (denies.length > 0) return { decision: 'deny', reasons: [...new Set(denies)] };
  if (asks.length > 0) return { decision: 'ask', reasons: [...new Set(asks)] };
  return { decision: null, reasons: [] };
}
