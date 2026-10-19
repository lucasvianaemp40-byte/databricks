// @ts-check
/**
 * Consultas rápidas ao git usadas pelos hooks. Todas falham em silêncio (devolvem null
 * ou false) quando não há repositório: quem chama decide o que isso significa.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string | null}
 */
function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Raiz do repositório que contém `cwd`.
 * @param {string} cwd
 * @returns {string | null}
 */
function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

/**
 * Nome da branch atual, ou null em HEAD destacado ou fora de um repositório.
 * @param {string} cwd
 * @returns {string | null}
 */
export function currentBranch(cwd) {
  return git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

/**
 * Ref da branch padrão: `origin/HEAD` e, na falta dele, origin/main, origin/master, main,
 * master. Rode `git remote set-head origin --auto`
 * para que `origin/HEAD` exista num clone antigo.
 * @param {string} cwd
 * @returns {string | null}
 */
function defaultBranchRef(cwd) {
  /** @type {string[]} */
  const candidates = [];
  const originHead = git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (originHead) candidates.push(originHead.replace(/^refs\/remotes\//, ''));
  candidates.push('origin/main', 'origin/master', 'main', 'master');
  for (const ref of candidates) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null) return ref;
  }
  return null;
}

/**
 * Indica se `absPath` (absoluto) existe na branch padrão. Usado para tornar imutáveis as
 * migrações já publicadas.
 * @param {string} cwd
 * @param {string} absPath
 * @returns {{ exists: boolean, ref: string | null, rel: string | null }}
 */
export function existsOnDefaultBranch(cwd, absPath) {
  const root = repoRoot(cwd);
  if (!root) return { exists: false, ref: null, rel: null };
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { exists: false, ref: null, rel: null };
  }
  const ref = defaultBranchRef(root);
  if (!ref) return { exists: false, ref: null, rel };
  const exists = git(root, ['cat-file', '-e', `${ref}:${rel}`]) !== null;
  return { exists, ref, rel };
}

/**
 * Configuração efetiva que decide o destino de um `git push` sem refspec: remote.*.push,
 * remote.*.mirror, push.default, branch.*.merge/pushRemote e remote.pushDefault.
 * @param {string} cwd
 * @returns {Array<[string, string]>}
 */
export function pushConfig(cwd) {
  const out = git(cwd, [
    'config',
    '--get-regexp',
    '^(remote\\..*\\.(push|mirror)|remote\\.pushdefault|push\\.default|branch\\..*\\.(merge|pushremote|remote))$',
  ]);
  if (!out) return [];
  return out.split('\n').flatMap((line) => {
    const space = line.indexOf(' ');
    if (space <= 0) return [];
    return [/** @type {[string, string]} */ ([line.slice(0, space), line.slice(space + 1)])];
  });
}
