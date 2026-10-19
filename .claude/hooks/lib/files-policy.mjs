// @ts-check
/**
 * Política do guard-files (ferramentas de arquivo do Claude Code).
 *
 * 1. Segredos: nega ler, editar ou buscar (Grep) em .env* (exceto .env.example), chaves,
 *    certificados, credenciais e diretórios de credenciais, quando o caminho ou o glob da
 *    chamada aponta para eles. Resolve links simbólicos, para que `atalho -> .env` não
 *    contorne a regra. Numa busca em diretório (Grep sem glob, ou com `*`/`.*`), quem tira
 *    os segredos do resultado são as regras nativas `Read(...)` de `permissions.deny`, que o
 *    Claude Code converte em exclusões do ripgrep; test/settings-deny.test.mjs mantém as
 *    duas camadas alinhadas.
 * 2. Lockfiles: só o gerenciador de pacotes escreve (pnpm install/add/remove, sob flock).
 * 3. Migrações: uma migração que já existe na branch padrão é imutável; corrija com uma nova.
 *    O `_journal.json` do drizzle-kit não é imutável, mas edição manual pede confirmação.
 * 4. Configuração de hooks git e do MCP (lefthook*, .git/hooks, .git/config, .husky,
 *    .mcp.json, .claude/mcp): escrita pede confirmação. `.claude/settings*.json` e
 *    `.claude/hooks/` já pedem aprovação pelas regras nativas (`permissions.ask`).
 * 5. Cobertura: acrescentar dica de exclusão (`v8 ignore`, `istanbul ignore`...) em src/,
 *    test/ ou e2e/ de um pacote pede confirmação (o test-hygiene do pacote também falha).
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { existsOnDefaultBranch as gitExistsOnDefaultBranch } from './git.mjs';
import {
  classifySecretPath,
  isLockfile,
  isMigrationPath,
  protectedConfigLevel,
  userClaudeConfigLevel,
} from './paths.mjs';

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
const MAX_GLOB_PARTS = 64;
/**
 * Dicas de exclusão de cobertura que o Vitest respeita (istanbul, c8, v8, node:coverage), a
 * mesma expressão dos meta-testes test-hygiene dos pacotes.
 */
const COVERAGE_HINT = /\b(?:istanbul|[cv]8|node:coverage)\s+(?:ignore|disable)\b/gi;
/** Diretórios que os meta-testes test-hygiene varrem. */
const COVERAGE_SCOPE = /^(?:packages|apps)\/[^/]+\/(?:src|test|e2e)\//;

/**
 * Quantas dicas de exclusão de cobertura a escrita acrescenta (texto novo menos o antigo).
 * @param {string} tool
 * @param {Record<string, any>} toolInput
 */
function addedCoverageHints(tool, toolInput) {
  /** @param {unknown} text */
  const count = (text) => (typeof text === 'string' ? (text.match(COVERAGE_HINT) ?? []).length : 0);
  if (tool === 'Write') return count(toolInput.content);
  if (tool === 'NotebookEdit') return count(toolInput.new_source);
  const edits =
    tool === 'MultiEdit' && Array.isArray(toolInput.edits) ? toolInput.edits : [toolInput];
  let added = 0;
  for (const edit of edits) added += count(edit?.new_string) - count(edit?.old_string);
  return added;
}

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
 * Separa `a,b` e `a b` fora de chaves (como a ferramenta Grep faz com o parâmetro glob).
 * @param {string} text
 * @returns {string[]}
 */
function splitGlobList(text) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (current !== '') parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') parts.push(current);
  return parts;
}

/**
 * Expande `{a,b}` (inclusive aninhado e com alternativa vazia: `.env{,.local}`).
 * @param {string} glob
 * @returns {string[]}
 */
function expandGlobBraces(glob) {
  /** @type {string[]} */
  const done = [];
  const queue = [glob];
  while (queue.length > 0 && done.length + queue.length <= MAX_GLOB_PARTS) {
    const item = /** @type {string} */ (queue.shift());
    const open = item.indexOf('{');
    let close = -1;
    let depth = 0;
    /** @type {number[]} */
    const commas = [];
    for (let i = open + 1; open >= 0 && i < item.length; i++) {
      const ch = item.charAt(i);
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (depth === 0) {
          close = i;
          break;
        }
        depth--;
      } else if (ch === ',' && depth === 0) commas.push(i);
    }
    if (open < 0 || close < 0) {
      done.push(item);
      continue;
    }
    let from = open + 1;
    for (const end of [...commas, close]) {
      queue.push(item.slice(0, open) + item.slice(from, end) + item.slice(close + 1));
      from = end + 1;
    }
  }
  return [...done, ...queue].slice(0, MAX_GLOB_PARTS);
}

/**
 * @param {string} glob
 * @returns {import('./paths.mjs').SecretMatch | null}
 */
function classifyGrepGlob(glob) {
  for (const part of splitGlobList(glob)) {
    const positive = part.replace(/^!/, '');
    if (positive !== part) continue; // exclusão (`!.env*`) não lê nada
    for (const expanded of expandGlobBraces(positive)) {
      const secret = classifySecretPath(expanded);
      if (secret) return secret;
    }
  }
  return null;
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
    const secret = classifyGrepGlob(toolInput.glob);
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
    const configLevel = inside ? protectedConfigLevel(rel) : null;
    if (configLevel === 'deny') {
      // Settings e hooks do próprio Claude Code: por Bash é negado (bash-policy); pela
      // ferramenta de arquivo, pede aprovação humana. Na nuvem as ferramentas de arquivo rodam
      // sem perguntar em qualquer modo, então a regra nativa `permissions.ask` não basta.
      asks.push(
        `Alteração da configuração do agente (${rel}): settings e hooks do Claude Code ligam ou desligam os guardas. Exige aprovação humana; confirme só se a mudança foi pedida e revisada.`,
      );
    } else if (configLevel === 'ask') {
      asks.push(
        `Alteração de configuração de hooks git/MCP (${rel}): pode desligar verificações ou executar código ao iniciar a sessão; confirme.`,
      );
    }
    // Configuração do Claude Code no escopo do usuário (~/.claude/settings.json): mesclada com
    // a do projeto, pode desligar os guardas; confirme.
    if (userClaudeConfigLevel(target) !== null) {
      asks.push(
        `Alteração de ${target} (configuração do Claude Code no escopo do usuário): pode desligar os guardas ou executar código ao iniciar a sessão; confirme.`,
      );
    }
    if (inside && COVERAGE_SCOPE.test(rel) && addedCoverageHints(tool, toolInput) > 0) {
      asks.push(
        `Dica de exclusão de cobertura (v8/c8/istanbul ignore, node:coverage) em ${rel}: a regra 3 do CLAUDE.md proíbe contornar o piso de cobertura e o test-hygiene do pacote vai falhar. Escreva o teste que cobre o trecho; confirme só se for removê-la antes do commit.`,
      );
    }
  }

  if (denies.length > 0) return { decision: 'deny', reasons: [...new Set(denies)] };
  if (asks.length > 0) return { decision: 'ask', reasons: [...new Set(asks)] };
  return { decision: null, reasons: [] };
}
