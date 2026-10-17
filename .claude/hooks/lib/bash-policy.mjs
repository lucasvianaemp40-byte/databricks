// @ts-check
/**
 * Política do guard-bash: decide `deny`, `ask` ou nada para um comando Bash.
 *
 * Princípios:
 * - Analisa a estrutura (lib/shell.mjs), não o texto cru: aspas, escapes, `sh -c`, `eval`,
 *   `$(...)`, heredocs e wrappers (`env`, `timeout`, `xargs`, `flock`, `pnpm exec`...) não
 *   escondem o comando real.
 * - `deny` vence `ask` (mesma precedência do Claude Code).
 * - Na dúvida estrutural (aspas sem fechar, nome de comando dinâmico), pede confirmação.
 * - Não bloqueia o trabalho normal: `pnpm test`, `git push -u origin claude/...`, commits
 *   com heredoc que citam `.env` ou `--force` no texto, `rm -rf node_modules`.
 *
 * Isto é defesa em profundidade, não sandbox: um script local (`node x.mjs`) pode fazer o
 * que quiser. As regras de permissão e o sandbox do sistema operacional são as outras camadas.
 */
import path from 'node:path';
import { existsOnDefaultBranch, currentBranch as gitCurrentBranch } from './git.mjs';
import {
  classifySecretPath,
  isLockfile,
  isMigrationPath,
  pathCandidates,
  protectedConfigLevel,
} from './paths.mjs';
import { findSubstitutions, parseShell } from './shell.mjs';

/** @typedef {import('./shell.mjs').SimpleCommand} SimpleCommand */

/**
 * @typedef {object} PolicyContext
 * @property {string} cwd diretório onde o comando roda
 * @property {string} projectDir raiz do projeto (CLAUDE_PROJECT_DIR)
 * @property {(cwd: string) => string | null} currentBranch
 * @property {(cwd: string, absPath: string) => { exists: boolean, ref: string | null, rel: string | null }} existsOnDefaultBranch
 */

/**
 * @typedef {object} PolicyResult
 * @property {'deny' | 'ask' | null} decision
 * @property {string[]} reasons
 */

const MAX_DEPTH = 6;
const MAX_SCRIPT_LENGTH = 30_000;

const PRIVILEGE_BINS = new Set(['sudo', 'doas', 'su', 'pkexec', 'run0']);
const SHELL_BINS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);
const STDIN_INTERPRETERS = new Set([
  ...SHELL_BINS,
  'python',
  'python3',
  'python2',
  'node',
  'perl',
  'ruby',
  'php',
  'deno',
  'bun',
  'tsx',
]);
const NETWORK_FETCHERS = new Set([
  'curl',
  'wget',
  'fetch',
  'http',
  'https',
  'httpie',
  'xh',
  'aria2c',
  'nc',
  'ncat',
  'socat',
  'ftp',
  'tftp',
  'gh',
]);
const RESERVED_LEADING = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'for',
  'in',
  'case',
  'esac',
  'function',
  'select',
  '!',
  '{',
  '}',
  'coproc',
]);
/** Diretórios de artefato que podem ser apagados sem confirmação. */
const SAFE_DELETE_BASENAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  '.vitest',
  'coverage',
  'tmp',
  '.tmp',
  'playwright-report',
  'blob-report',
  'test-results',
  'storybook-static',
  '.vercel',
  '.output',
  '.playwright-mcp',
  '.playwright-cli',
  '.eslintcache',
  'tsconfig.tsbuildinfo',
]);
const SYSTEM_DIRS =
  /^\/(?:bin|boot|dev|etc|lib|lib32|lib64|libx32|opt|proc|root|run|sbin|srv|sys|usr|var|home|Users|mnt|media|snap|nix|System|Library|Applications)(?:\/|$)/;
/** Comandos que só citam o nome de um arquivo de segredo, sem ler o conteúdo. */
const SECRET_NAME_ONLY_BINS = new Set([
  'ls',
  'test',
  '[',
  '[[',
  'stat',
  'touch',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'echo',
  'printf',
]);
const OUTPUT_BINS = new Set(['echo', 'printf', 'print', 'logger', 'wall', 'notify-send']);
const HOOK_BYPASS_ENV =
  /^(?:LEFTHOOK|HUSKY|SKIP_SIMPLE_GIT_HOOKS|SIMPLE_GIT_HOOKS)=(?:0|false|off|no)?$/i;

const FORK_BOMB = /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;?\s*:/;

/**
 * Nome de variável de ambiente que provavelmente guarda segredo.
 * @param {string} name
 */
function isSensitiveVarName(name) {
  return (
    /(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|CREDENTIAL|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY|SERVICE_ROLE|AUTH_KEY|CLIENT_KEY)/i.test(
      name,
    ) ||
    /(?:^|_)(?:PASS|PAT|COOKIES?|SESSION_KEY)(?:_|$)/i.test(name) ||
    /(?:DATABASE|DB|PG|POSTGRES|POSTGRESQL|MYSQL|REDIS|MONGO|MONGODB|AMQP|RABBITMQ)[A-Z0-9_]*_(?:URL|URI|DSN)$/i.test(
      name,
    ) ||
    /^(?:DATABASE_URL|DATABASE_URI|DSN)$/i.test(name)
  );
}

/**
 * Variáveis referenciadas como `$NOME` ou `${NOME...}` num texto.
 * @param {string} text
 * @returns {string[]}
 */
function referencedVars(text) {
  /** @type {string[]} */
  const names = [];
  for (const m of String(text).matchAll(/\$\{?#?!?([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

class Verdict {
  constructor() {
    /** @type {string[]} */
    this.denies = [];
    /** @type {string[]} */
    this.asks = [];
  }

  /** @param {string} reason */
  deny(reason) {
    this.denies.push(reason);
  }

  /** @param {string} reason */
  ask(reason) {
    this.asks.push(reason);
  }

  /** @returns {PolicyResult} */
  result() {
    if (this.denies.length > 0) return { decision: 'deny', reasons: [...new Set(this.denies)] };
    if (this.asks.length > 0) return { decision: 'ask', reasons: [...new Set(this.asks)] };
    return { decision: null, reasons: [] };
  }
}

/**
 * Contexto real (consulta o git do repositório).
 * @param {{ cwd: string, projectDir: string }} base
 * @returns {PolicyContext}
 */
export function createContext(base) {
  return {
    cwd: base.cwd,
    projectDir: base.projectDir,
    currentBranch: gitCurrentBranch,
    existsOnDefaultBranch,
  };
}

/**
 * Avalia um comando Bash completo.
 * @param {string} command
 * @param {PolicyContext} ctx
 * @returns {PolicyResult}
 */
export function evaluateBashCommand(command, ctx) {
  const verdict = new Verdict();
  analyzeScript(String(command ?? ''), ctx, 0, verdict);
  return verdict.result();
}

/**
 * @param {string} script
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function analyzeScript(script, ctx, depth, v) {
  if (depth > MAX_DEPTH) {
    v.ask('Comando com aninhamento profundo demais (sh -c, eval, $(...)) para análise; confirme.');
    return;
  }
  if (script.length > MAX_SCRIPT_LENGTH) {
    v.ask('Comando longo demais para análise automática; confirme manualmente.');
  }
  if (FORK_BOMB.test(script)) v.deny('Fork bomb bloqueada.');
  const parsed = parseShell(script);
  for (const error of parsed.errors) {
    v.ask(`Não consegui analisar o comando com segurança (${error}); confirme.`);
  }
  for (const cmd of parsed.commands) {
    for (const sub of cmd.substitutions) analyzeScript(sub, ctx, depth + 1, v);
    for (const sub of cmd.processSubstitutions) analyzeScript(sub, ctx, depth + 1, v);
    for (const heredoc of cmd.heredocs) {
      if (!heredoc.expand) continue;
      const found = findSubstitutions(heredoc.body);
      for (const sub of found.subs) analyzeScript(sub, ctx, depth + 1, v);
      for (const error of found.errors) v.ask(`Heredoc com expansão não analisável (${error}).`);
    }
    analyzeSimpleCommand(cmd, parsed.commands, ctx, depth, v);
  }
}

/**
 * @param {string} word
 */
function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(word);
}

/**
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function analyzeSimpleCommand(cmd, all, ctx, depth, v) {
  for (const redirect of cmd.redirects) checkRedirect(redirect, ctx, v);
  const words = [...cmd.words];
  const dynamic = [...cmd.dynamic];
  while (words.length > 0 && RESERVED_LEADING.has(words[0] ?? '') && !dynamic[0]) {
    words.shift();
    dynamic.shift();
  }
  while (words.length > 0 && isAssignment(words[0] ?? '')) {
    checkAssignment(words[0] ?? '', v);
    words.shift();
    dynamic.shift();
  }
  if (words.length === 0) return;
  analyzeArgv(words, dynamic, cmd, all, ctx, depth, v);
}

/**
 * @param {string} assignment
 * @param {Verdict} v
 */
function checkAssignment(assignment, v) {
  if (
    HOOK_BYPASS_ENV.test(assignment) ||
    /^(?:LEFTHOOK_EXCLUDE|HUSKY_SKIP_HOOKS|SKIP)=/.test(assignment)
  ) {
    v.deny('Desativar os hooks git (LEFTHOOK=0, HUSKY=0...) é proibido: corrija a causa da falha.');
  }
  if (/^GIT_CONFIG_(?:PARAMETERS|KEY_\d+|VALUE_\d+)=.*hookspath/i.test(assignment)) {
    v.deny('Alterar core.hooksPath por variável de ambiente desliga os hooks; proibido.');
  }
}

/**
 * Interpreta o comando, removendo wrappers até chegar ao programa real.
 * @param {string[]} argvIn
 * @param {boolean[]} dynamicIn
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function analyzeArgv(argvIn, dynamicIn, cmd, all, ctx, depth, v) {
  let argv = argvIn;
  let dynamic = dynamicIn;
  for (let guard = 0; guard < 16 && argv.length > 0; guard++) {
    const first = argv[0] ?? '';
    if (dynamic[0] || /[$`]/.test(first)) {
      v.ask(`Nome de comando dinâmico (${first}); confirme o que será executado.`);
      return;
    }
    const bin = path.posix.basename(first);
    const args = argv.slice(1);
    const argsDynamic = dynamic.slice(1);
    const next = unwrap(bin, args, argsDynamic, cmd, all, ctx, depth, v);
    if (next === 'stop') return;
    if (next) {
      argv = next.argv;
      dynamic = next.dynamic;
      continue;
    }
    checkCommand(bin, args, argsDynamic, cmd, all, ctx, depth, v);
    return;
  }
  if (argv.length > 0) v.ask('Cadeia de wrappers longa demais para análise; confirme.');
}

/**
 * Pula opções no início de `args`. `valueOpts` lista as opções que consomem o próximo
 * argumento. Para em `--` (consumindo-o) ou no primeiro argumento posicional.
 * @param {string[]} args
 * @param {Set<string>} valueOpts
 * @returns {number} índice do primeiro posicional
 */
function skipOptions(args, valueOpts) {
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '--') return i + 1;
    if (!a.startsWith('-') || a === '-') return i;
    if (valueOpts.has(a)) i += 2;
    else i++;
  }
  return i;
}

/**
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {number} from
 */
function slice(args, dynamic, from) {
  return { argv: args.slice(from), dynamic: dynamic.slice(from) };
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 * @returns {{ argv: string[], dynamic: boolean[] } | 'stop' | null}
 */
function unwrap(bin, args, dynamic, cmd, all, ctx, depth, v) {
  if (PRIVILEGE_BINS.has(bin)) {
    v.deny(`${bin} não é permitido em sessões do agente.`);
    return 'stop';
  }
  switch (bin) {
    case 'env':
      return unwrapEnv(args, dynamic, ctx, depth, v);
    case 'command': {
      if (args[0] === '-v' || args[0] === '-V') return 'stop';
      return slice(args, dynamic, skipOptions(args, new Set()));
    }
    case 'builtin':
    case 'nohup':
    case 'noglob':
    case 'nocorrect':
    case 'chronic':
    case 'unbuffer':
      return slice(args, dynamic, args[0] === '--' ? 1 : 0);
    case 'exec':
      return slice(args, dynamic, skipOptions(args, new Set(['-a'])));
    case 'time':
      return slice(args, dynamic, skipOptions(args, new Set(['-f', '--format', '-o', '--output'])));
    case 'setsid':
    case 'caffeinate':
      return slice(args, dynamic, skipOptions(args, new Set(['-t', '-w'])));
    case 'nice':
      return slice(args, dynamic, skipOptions(args, new Set(['-n'])));
    case 'ionice':
      if (args.includes('-p') || args.includes('-P')) return 'stop';
      return slice(args, dynamic, skipOptions(args, new Set(['-c', '-n'])));
    case 'stdbuf':
      return slice(args, dynamic, skipOptions(args, new Set(['-i', '-o', '-e'])));
    case 'timeout': {
      const i = skipOptions(args, new Set(['-s', '-k', '--signal', '--kill-after']));
      return slice(args, dynamic, i + 1);
    }
    case 'watch': {
      const i = skipOptions(args, new Set(['-n', '--interval', '-q', '--equexit']));
      if (args.includes('-x') || args.includes('--exec')) return slice(args, dynamic, i);
      analyzeScript(args.slice(i).join(' '), ctx, depth + 1, v);
      return 'stop';
    }
    case 'flock':
      return unwrapFlock(args, dynamic, ctx, depth, v);
    case 'xargs':
      return unwrapXargs(args, dynamic);
    case 'busybox':
      return slice(args, dynamic, 0);
    case 'eval': {
      if (dynamic.some(Boolean)) {
        v.ask('eval com conteúdo dinâmico; confirme o que será executado.');
        if (cmd.substitutions.some(scriptFetchesNetwork)) {
          v.deny('Executar código baixado da rede (eval "$(curl ...)") é proibido.');
        }
      }
      analyzeScript(args.join(' '), ctx, depth + 1, v);
      return 'stop';
    }
    case 'alias':
      for (const a of args) {
        const eq = a.indexOf('=');
        if (eq > 0) analyzeScript(a.slice(eq + 1), ctx, depth + 1, v);
      }
      return 'stop';
    case 'trap':
      if (args[0]) analyzeScript(args[0], ctx, depth + 1, v);
      return 'stop';
    case 'source':
    case '.':
      checkSource(args, dynamic, cmd, v);
      return 'stop';
    case 'npx':
    case 'pnpx':
    case 'bunx':
      return unwrapNpx(bin, args, dynamic, ctx, depth, v);
    case 'pnpm':
      return unwrapPnpm(args, dynamic, ctx, depth, v);
    case 'npm':
      if (args[0] === 'exec' || args[0] === 'x') {
        return unwrapNpx('npm exec', args.slice(1), dynamic.slice(1), ctx, depth, v);
      }
      return null;
    case 'yarn':
      if (args[0] === 'dlx')
        return unwrapNpx('yarn dlx', args.slice(1), dynamic.slice(1), ctx, depth, v);
      if (args[0] === 'exec') return slice(args, dynamic, 1);
      return null;
    case 'bun':
      if (args[0] === 'x')
        return unwrapNpx('bun x', args.slice(1), dynamic.slice(1), ctx, depth, v);
      return null;
    case 'dotenv':
    case 'dotenvx':
    case 'env-cmd': {
      v.ask(
        `${bin} carrega um arquivo .env no processo: confirme que nada vai imprimir os valores.`,
      );
      const dd = args.indexOf('--');
      if (dd >= 0) return slice(args, dynamic, dd + 1);
      const i = skipOptions(args, new Set(['-e', '-f', '-v', '-c', '-p']));
      return slice(args, dynamic, i);
    }
    case 'direnv':
      if (args[0] === 'exec') return slice(args, dynamic, 2);
      return null;
    case 'mise':
    case 'rtx': {
      const dd = args.indexOf('--');
      if ((args[0] === 'exec' || args[0] === 'x') && dd >= 0) return slice(args, dynamic, dd + 1);
      return null;
    }
    case 'devbox':
      if (args[0] === 'run') return slice(args, dynamic, 1);
      return null;
    default:
      if (SHELL_BINS.has(bin) || bin === 'pwsh' || bin === 'powershell') {
        checkShell(bin, args, dynamic, cmd, all, ctx, depth, v);
        return 'stop';
      }
      return null;
  }
}

/**
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 * @returns {{ argv: string[], dynamic: boolean[] } | 'stop'}
 */
function unwrapEnv(args, dynamic, ctx, depth, v) {
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-S' || a === '--split-string') {
      analyzeScript(args.slice(i + 1).join(' '), ctx, depth + 1, v);
      return 'stop';
    }
    if (a.startsWith('--split-string=')) {
      analyzeScript(a.slice('--split-string='.length), ctx, depth + 1, v);
      return 'stop';
    }
    if (a === '-u' || a === '--unset' || a === '-C' || a === '--chdir') {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    if (isAssignment(a)) {
      checkAssignment(a, v);
      i++;
      continue;
    }
    break;
  }
  if (i >= args.length) {
    v.deny('Despejar as variáveis de ambiente (env) expõe segredos.');
    return 'stop';
  }
  return slice(args, dynamic, i);
}

/**
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 * @returns {{ argv: string[], dynamic: boolean[] } | 'stop'}
 */
function unwrapFlock(args, dynamic, ctx, depth, v) {
  const valueOpts = new Set(['-w', '--timeout', '-E', '--conflict-exit-code']);
  let lockSeen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '-c' || a === '--command') {
      analyzeScript(args[i + 1] ?? '', ctx, depth + 1, v);
      return 'stop';
    }
    if (valueOpts.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (!lockSeen) {
      lockSeen = true;
      continue;
    }
    return slice(args, dynamic, i);
  }
  return 'stop';
}

/**
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @returns {{ argv: string[], dynamic: boolean[] }}
 */
function unwrapXargs(args, dynamic) {
  const valueOpts = new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s']);
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-')) break;
    if (valueOpts.has(a)) i += 2;
    else i++;
  }
  const rest = slice(args, dynamic, i);
  if (rest.argv.length === 0) return { argv: ['echo'], dynamic: [false] };
  // Os argumentos que o xargs acrescenta vêm do stdin: desconhecidos.
  return { argv: [...rest.argv, '{xargs}'], dynamic: [...rest.dynamic, true] };
}

/**
 * @param {string} label
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 * @returns {{ argv: string[], dynamic: boolean[] } | 'stop'}
 */
function unwrapNpx(label, args, dynamic, ctx, depth, v) {
  let noInstall = false;
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-c' || a === '--call' || a === '--shell-mode') {
      analyzeScript(args[i + 1] ?? '', ctx, depth + 1, v);
      return 'stop';
    }
    if (a === '--no-install' || a === '--no' || a === '--offline') noInstall = true;
    if (a === '-p' || a === '--package') {
      i += 2;
      continue;
    }
    if (!a.startsWith('-')) break;
    i++;
  }
  if (!noInstall) {
    v.ask(
      `${label} pode baixar e executar um pacote do registro. Prefira o binário local (pnpm exec) ou uma versão fixa que já passou da quarentena de 3 dias.`,
    );
  }
  return slice(args, dynamic, i);
}

/**
 * Trata `pnpm exec`/`pnpm dlx` como wrappers; o resto vai para `checkPnpm`.
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 * @returns {{ argv: string[], dynamic: boolean[] } | 'stop' | null}
 */
function unwrapPnpm(args, dynamic, ctx, depth, v) {
  const { sub, index } = pnpmSubcommand(args);
  if (sub === 'exec') {
    let i = index + 1;
    while (i < args.length && (args[i] ?? '').startsWith('-')) {
      const a = args[i] ?? '';
      if (a === '-c' || a === '--shell-mode') {
        analyzeScript(args.slice(i + 1).join(' '), ctx, depth + 1, v);
        return 'stop';
      }
      i++;
    }
    return slice(args, dynamic, i);
  }
  if (sub === 'dlx') {
    return unwrapNpx('pnpm dlx', args.slice(index + 1), dynamic.slice(index + 1), ctx, depth, v);
  }
  if (sub === null || PNPM_BUILTINS.has(sub)) return null;
  if (DB_SCRIPT.test(sub)) {
    v.ask(`Script "${sub}" roda contra banco/ambiente real; confirme o alvo (nunca produção).`);
    return 'stop';
  }
  // `pnpm <nome>` roda um script do package.json ou um binário de node_modules/.bin.
  return slice(args, dynamic, index);
}

/** Comandos próprios do pnpm (o resto é script do package.json ou binário local). */
const PNPM_BUILTINS = new Set([
  'add',
  'install',
  'i',
  'update',
  'up',
  'upgrade',
  'remove',
  'rm',
  'uninstall',
  'un',
  'link',
  'ln',
  'unlink',
  'import',
  'rebuild',
  'rb',
  'prune',
  'fetch',
  'patch',
  'patch-commit',
  'patch-remove',
  'approve-builds',
  'audit',
  'list',
  'ls',
  'll',
  'outdated',
  'why',
  'licenses',
  'publish',
  'pack',
  'run',
  'run-script',
  'test',
  't',
  'tst',
  'start',
  'init',
  'create',
  'store',
  'root',
  'bin',
  'env',
  'config',
  'c',
  'get',
  'set',
  'setup',
  'server',
  'deploy',
  'doctor',
  'self-update',
  'recursive',
  'multi',
  'm',
  'exec',
  'dlx',
  'cat-file',
  'cat-index',
  'find-hash',
  'help',
  'dedupe',
  'ignored-builds',
  'sbom',
  'stage',
  'version',
]);
const DB_SCRIPT = /^(?:migrate|db:migrate|db:push|db:reset|db:drop|db:seed:prod|deploy)$/;

/**
 * @param {string[]} args
 * @returns {{ sub: string | null, index: number }}
 */
function pnpmSubcommand(args) {
  const valueOpts = new Set([
    '--filter',
    '-F',
    '--dir',
    '-C',
    '--reporter',
    '--loglevel',
    '--resume-from',
    '--workspace-concurrency',
    '--test-pattern',
    '--changed-files-ignore-pattern',
  ]);
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (valueOpts.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    return { sub: a, index: i };
  }
  return { sub: null, index: i };
}

/**
 * @param {string} script
 * @returns {boolean}
 */
function scriptFetchesNetwork(script) {
  const parsed = parseShell(script);
  return parsed.commands.some((c) => NETWORK_FETCHERS.has(effectiveBin(c)));
}

/**
 * Programa efetivo de um comando simples (pula atribuições e wrappers simples).
 * @param {SimpleCommand} cmd
 * @returns {string}
 */
function effectiveBin(cmd) {
  const wrappers = new Set([
    'env',
    'command',
    'builtin',
    'exec',
    'nohup',
    'time',
    'nice',
    'stdbuf',
  ]);
  for (const w of cmd.words) {
    if (isAssignment(w) || w.startsWith('-') || RESERVED_LEADING.has(w)) continue;
    const bin = path.posix.basename(w);
    if (wrappers.has(bin) || PRIVILEGE_BINS.has(bin)) continue;
    return bin;
  }
  return '';
}

/**
 * @param {SimpleCommand} cmd
 */
function isDecoderCommand(cmd) {
  const bin = effectiveBin(cmd);
  const words = cmd.words;
  if (['gunzip', 'zcat', 'bzcat', 'xzcat', 'uudecode', 'rev'].includes(bin)) return true;
  if (bin === 'base64') return words.some((w) => w === '-d' || w === '--decode' || w === '-D');
  if (bin === 'xxd') return words.some((w) => w === '-r' || w === '-revert');
  if (bin === 'openssl') return words.some((w) => w === '-d' || w === 'base64' || w === 'enc');
  if (['gzip', 'bzip2', 'xz', 'zstd'].includes(bin)) return words.some((w) => /^-[a-z]*d/.test(w));
  return bin === 'tr' || bin === 'printf';
}

/**
 * Regra de pipe para interpretador (`curl ... | bash`, `base64 -d | sh`).
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {Verdict} v
 */
function checkPipeIntoInterpreter(cmd, all, v) {
  if (!cmd.pipedIn) return;
  const index = all.indexOf(cmd);
  const upstream = all.filter((c, k) => k < index && c.pipeline === cmd.pipeline);
  if (upstream.some((c) => NETWORK_FETCHERS.has(effectiveBin(c)))) {
    v.deny(
      'Executar script baixado da rede via pipe para um interpretador é proibido (supply chain). Baixe, revise e fixe a versão.',
    );
    return;
  }
  if (upstream.some(isDecoderCommand)) {
    v.deny(
      'Executar conteúdo decodificado (base64, xxd, gzip...) via pipe é proibido: padrão de ofuscação.',
    );
    return;
  }
  v.ask('Conteúdo enviado por pipe para um interpretador; confirme o que será executado.');
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkShell(bin, args, dynamic, cmd, all, ctx, depth, v) {
  if (bin === 'pwsh' || bin === 'powershell') {
    v.ask('Comandos PowerShell não são analisados pelo guard-bash; confirme.');
    return;
  }
  /** @type {string | null} */
  let script = null;
  let scriptDynamic = false;
  /** @type {string | null} */
  let fileArg = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '-c' || (/^-[A-Za-z]*c[A-Za-z]*$/.test(a) && !a.startsWith('--'))) {
      script = args[i + 1] ?? '';
      scriptDynamic = dynamic[i + 1] ?? false;
      break;
    }
    if (a === '-s') break;
    if (
      a === '-o' ||
      a === '+o' ||
      a === '-O' ||
      a === '+O' ||
      a === '--rcfile' ||
      a === '--init-file'
    ) {
      i++;
      continue;
    }
    if (a === '--') {
      fileArg = args[i + 1] ?? null;
      break;
    }
    if (a.startsWith('-') || a.startsWith('+')) continue;
    fileArg = a;
    break;
  }
  if (script !== null) {
    if (scriptDynamic) {
      if (cmd.substitutions.some(scriptFetchesNetwork)) {
        v.deny('Executar código baixado da rede (sh -c "$(curl ...)") é proibido.');
      } else {
        v.ask(`${bin} -c com conteúdo dinâmico; confirme o que será executado.`);
      }
    }
    analyzeScript(script, ctx, depth + 1, v);
    return;
  }
  if (fileArg !== null && fileArg !== '-') {
    if (fileArg === '/dev/fd/63' && cmd.processSubstitutions.some(scriptFetchesNetwork)) {
      v.deny('Executar script baixado da rede (bash <(curl ...)) é proibido (supply chain).');
      return;
    }
    checkSecretMentions(bin, [fileArg], [false], v);
    return;
  }
  if (cmd.heredocs.length > 0) {
    for (const heredoc of cmd.heredocs) analyzeScript(heredoc.body, ctx, depth + 1, v);
    return;
  }
  if (cmd.hereStrings.length > 0) {
    for (const text of cmd.hereStrings) analyzeScript(text, ctx, depth + 1, v);
    return;
  }
  checkPipeIntoInterpreter(cmd, all, v);
}

/**
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {SimpleCommand} cmd
 * @param {Verdict} v
 */
function checkSource(args, dynamic, cmd, v) {
  const target = args[0];
  if (target === undefined) return;
  if (target === '/dev/fd/63' && cmd.processSubstitutions.some(scriptFetchesNetwork)) {
    v.deny('Carregar script baixado da rede (source <(curl ...)) é proibido.');
    return;
  }
  if (dynamic[0]) {
    v.ask(`source com caminho dinâmico (${target}); confirme.`);
    return;
  }
  for (const candidate of pathCandidates(target)) {
    const secret = classifySecretPath(candidate);
    if (secret) {
      v.deny(
        `Carregar ${secret.reason} no shell expõe segredos. Use variáveis já injetadas no ambiente.`,
      );
      return;
    }
  }
}

/**
 * @param {import('./shell.mjs').Redirect} redirect
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkRedirect(redirect, ctx, v) {
  const { op, target } = redirect;
  if (op === '>&' || op === '<&') {
    if (/^\d+-?$|^-$/.test(target)) return;
  }
  if (redirect.dynamic) {
    if (op !== '<') v.ask(`Redirecionamento para destino dinâmico (${target}); confirme.`);
    return;
  }
  for (const candidate of pathCandidates(target)) {
    const secret = classifySecretPath(candidate);
    if (secret) {
      v.deny(`Redirecionamento envolvendo ${secret.reason} bloqueado.`);
      return;
    }
  }
  if (op === '<') return;
  checkWriteTarget(target, ctx, v, 'redirecionamento');
}

/** Comandos que só mudam metadados (permissão, dono), não o conteúdo. */
const METADATA_BINS = new Set(['chmod', 'chown', 'chgrp', 'chattr']);

/**
 * Regras para qualquer escrita (redirecionamento, tee, cp, mv, sed -i, rm...).
 * @param {string} target
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 * @param {string} how
 */
function checkWriteTarget(target, ctx, v, how) {
  if (
    target === '' ||
    target.startsWith('/dev/null') ||
    /^\/dev\/(?:stdout|stderr|tty|fd\/\d+)$/.test(target)
  ) {
    return;
  }
  if (/^\/dev\//.test(target)) {
    v.deny(`Escrita direta em dispositivo (${target}) bloqueada.`);
    return;
  }
  const abs = path.resolve(ctx.cwd, target.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  const userArea =
    /^\/(?:home|Users|root|tmp|private\/tmp|var\/folders)(?:\/|$)/.test(abs) ||
    abs.startsWith(ctx.projectDir);
  if (SYSTEM_DIRS.test(abs) && !userArea) {
    v.deny(`Escrita em diretório do sistema (${abs}) bloqueada.`);
    return;
  }
  const home = process.env.HOME;
  if (
    home &&
    path.dirname(abs) === home &&
    /^\.(?:bashrc|bash_profile|profile|zshrc|zprofile|zshenv|gitconfig)$/.test(path.basename(abs))
  ) {
    v.ask(`Alteração de ${path.basename(abs)} no diretório do usuário (${how}); confirme.`);
  }
  const rel = path.relative(ctx.projectDir, abs).split(path.sep).join('/');
  const insideProject = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (insideProject) {
    const raw = protectedConfigLevel(rel);
    const level = raw === 'deny' && METADATA_BINS.has(how) ? 'ask' : raw;
    if (level === 'deny') {
      v.deny(
        `Alterar ${rel} por Bash desligaria as proteções do agente. Use a ferramenta Edit (caminho protegido, exige aprovação humana).`,
      );
    } else if (level === 'ask') {
      v.ask(`Alteração de configuração de hooks/MCP (${rel}) via ${how}; confirme.`);
    }
  }
  if (isLockfile(abs)) {
    v.deny(
      `Não edite ${path.basename(abs)} à mão (${how}); use pnpm install/add/remove (com flock).`,
    );
  }
  if (insideProject && isMigrationPath(rel)) {
    const info = ctx.existsOnDefaultBranch(ctx.projectDir, abs);
    if (info.exists) {
      v.deny(
        `Migração já publicada em ${info.ref} (${rel}) é imutável. Crie uma NOVA migração (forward-only) que corrija o schema.`,
      );
    }
  }
}

/**
 * Lista os caminhos que um comando conhecido vai escrever ou apagar.
 * @param {string} bin
 * @param {string[]} args
 * @returns {string[]}
 */
function writeTargets(bin, args) {
  const positionals = args.filter((a) => !a.startsWith('-'));
  switch (bin) {
    case 'tee':
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
    case 'truncate':
    case 'rimraf':
    case 'mv':
      return positionals;
    case 'cp':
    case 'install':
    case 'ln':
    case 'rsync': {
      const t = args.indexOf('-t');
      if (t >= 0 && args[t + 1]) return [args[t + 1] ?? ''];
      const last = positionals.at(-1);
      return last ? [last] : [];
    }
    case 'chmod':
    case 'chown':
    case 'chgrp':
    case 'chattr':
      return modeChangeOperands(bin, args).targets;
    case 'sed':
    case 'gsed':
    case 'perl':
    case 'ruby': {
      const inPlace = args.some(
        (a) => /^-(?:i|pi|[a-hj-z]*i[a-z.]*)$/.test(a) || a.startsWith('--in-place'),
      );
      if (!inPlace) return [];
      const hasScriptOpt = args.some((a) => a === '-e' || a === '-f' || a === '--expression');
      return hasScriptOpt ? positionals : positionals.slice(1);
    }
    case 'dd':
      return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
    case 'curl': {
      /** @type {string[]} */
      const out = [];
      args.forEach((a, k) => {
        if ((a === '-o' || a === '--output') && args[k + 1]) out.push(args[k + 1] ?? '');
      });
      return out;
    }
    case 'wget': {
      /** @type {string[]} */
      const out = [];
      args.forEach((a, k) => {
        if (a === '-O' && args[k + 1]) out.push(args[k + 1] ?? '');
        if (a.startsWith('--output-document=')) out.push(a.slice('--output-document='.length));
      });
      return out;
    }
    default:
      return [];
  }
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {Verdict} v
 */
function checkSecretMentions(bin, args, dynamic, v) {
  const nameOnly = SECRET_NAME_ONLY_BINS.has(bin);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (dynamic[i] && /\$/.test(arg) && !/\.env|id_rsa|\.pem|\.key\b|\.ssh|\.aws|environ/.test(arg))
      continue;
    for (const candidate of pathCandidates(arg)) {
      const secret = classifySecretPath(candidate);
      if (!secret) continue;
      if (secret.kind === 'file' && nameOnly) continue;
      v.deny(
        `Acesso a ${secret.reason} bloqueado. Use .env.example como referência; segredos ficam fora do alcance do agente.`,
      );
      return;
    }
  }
}

/**
 * Regras específicas por programa.
 * @param {string} bin
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkCommand(bin, args, dynamic, cmd, all, ctx, depth, v) {
  // --env-file carrega segredos num processo: pede confirmação em vez de negar.
  /** @type {Set<number>} */
  const handled = new Set();
  args.forEach((a, k) => {
    const m = /^--env-file(?:-if-exists)?(?:=(.*))?$/.exec(a);
    if (!m) return;
    const value = m[1] ?? args[k + 1] ?? '';
    handled.add(k);
    if (m[1] === undefined) handled.add(k + 1);
    if (classifySecretPath(value)) {
      v.ask('Carregar .env num processo (--env-file): confirme que nada vai imprimir os valores.');
    }
  });

  for (const k of patternArgumentIndexes(bin, args)) handled.add(k);
  if (!secretMentionsAllowed(bin, args)) {
    const keep = args.map((_a, k) => !handled.has(k));
    checkSecretMentions(
      bin,
      args.filter((_a, k) => keep[k]),
      dynamic.filter((_d, k) => keep[k]),
      v,
    );
  }

  for (const target of writeTargets(bin, args)) checkWriteTarget(target, ctx, v, bin);

  if (OUTPUT_BINS.has(bin) || bin === 'cat') {
    const texts = OUTPUT_BINS.has(bin) ? [...args, ...cmd.hereStrings] : cmd.hereStrings;
    for (const text of texts) {
      const leaked = referencedVars(text).find(isSensitiveVarName);
      if (leaked) {
        v.deny(`Não imprima variáveis sensíveis (${leaked}) no terminal/transcript.`);
        break;
      }
    }
  }

  switch (bin) {
    case 'rm':
    case 'rimraf':
      checkRm(bin, args, dynamic, ctx, v);
      break;
    case 'find':
      checkFind(args, dynamic, cmd, all, ctx, depth, v);
      break;
    case 'git':
      checkGit(args, dynamic, ctx, v);
      break;
    case 'gh':
      checkGh(args, v);
      break;
    case 'chmod':
    case 'chown':
    case 'chgrp':
      checkChmod(bin, args, ctx, v);
      break;
    case 'dd':
      if (args.some((a) => /^of=\/dev\/(?!null$)/.test(a)))
        v.deny('dd gravando em dispositivo é proibido.');
      break;
    case 'shred':
      v.ask('shred apaga dados de forma irrecuperável; confirme.');
      break;
    case 'shutdown':
    case 'reboot':
    case 'halt':
    case 'poweroff':
      v.deny('Desligar ou reiniciar a máquina é proibido.');
      break;
    case 'systemctl':
      if (args.some((a) => /^(?:poweroff|reboot|halt|kexec|emergency|rescue)$/.test(a))) {
        v.deny('Desligar ou reiniciar a máquina é proibido.');
      }
      break;
    case 'init':
    case 'telinit':
      if (args[0] === '0' || args[0] === '6') v.deny('Desligar ou reiniciar a máquina é proibido.');
      break;
    case 'kill':
      if (args.includes('-1')) v.deny('kill -1 encerra todos os processos do usuário; proibido.');
      break;
    case 'printenv':
      if (args.filter((a) => !a.startsWith('-')).length === 0) {
        v.deny('Despejar as variáveis de ambiente (printenv) expõe segredos.');
      } else if (args.some(isSensitiveVarName)) {
        v.deny('printenv de variável sensível é bloqueado.');
      }
      break;
    case 'export':
      if (args.length === 0 || args.includes('-p')) {
        v.deny('Despejar o ambiente do shell (export -p) expõe segredos.');
      }
      for (const a of args) checkAssignment(a, v);
      break;
    case 'declare':
    case 'typeset': {
      const names = args.filter((a) => !/^[-+]/.test(a));
      const onlyFunctions = args.length > 0 && args.every((a) => /^-[fF]+$/.test(a));
      if (names.length === 0 && !onlyFunctions) {
        v.deny('Despejar variáveis do shell (declare/typeset sem nomes, -p, -x) expõe segredos.');
      } else if (
        args.some((a) => /^-[a-zA-Z]*p/.test(a)) &&
        names.some((n) => isSensitiveVarName(n.split('=')[0] ?? ''))
      ) {
        v.deny('Não imprima variáveis sensíveis (declare -p) no terminal/transcrição.');
      }
      break;
    }
    case 'set':
      if (args.length === 0) v.deny('`set` sem argumentos despeja todas as variáveis do shell.');
      break;
    case 'ps': {
      const valueOpts = new Set([
        '-o',
        '-O',
        '-p',
        '-q',
        '-u',
        '-U',
        '-g',
        '-G',
        '-t',
        '-C',
        '-k',
        '--format',
        '--pid',
        '--ppid',
        '--sort',
      ]);
      const bsdEnv = args.some(
        (a, k) =>
          !a.startsWith('-') &&
          !valueOpts.has(args[k - 1] ?? '') &&
          /^[a-zA-Z]+$/.test(a) &&
          a.includes('e'),
      );
      if (bsdEnv)
        v.deny('ps com a opção "e" (estilo BSD) imprime o ambiente dos processos (segredos).');
      break;
    }
    case 'curl':
    case 'wget':
    case 'http':
    case 'xh':
      for (const a of args) {
        const leaked = referencedVars(a).find(isSensitiveVarName);
        if (leaked) {
          v.ask(`Envio de variável sensível (${leaked}) pela rede; confirme o destino.`);
          break;
        }
      }
      break;
    case 'bun':
      if (args[0] === 'add' || args[0] === 'install' || args[0] === 'i') {
        v.ask(`Este repositório usa pnpm; bun ${args[0]} criaria outro lockfile. Confirme.`);
        break;
      }
      checkInterpreter(bin, args, dynamic, cmd, all, ctx, depth, v);
      break;
    case 'node':
    case 'tsx':
    case 'ts-node':
    case 'deno':
    case 'python':
    case 'python3':
    case 'python2':
    case 'perl':
    case 'ruby':
    case 'php':
      checkInterpreter(bin, args, dynamic, cmd, all, ctx, depth, v);
      break;
    case 'psql':
    case 'pgcli':
    case 'mysql':
    case 'mariadb':
    case 'sqlite3':
    case 'mongosh':
    case 'mongo':
    case 'redis-cli':
      checkDbClient(bin, args, cmd, v);
      break;
    case 'dropdb':
    case 'dropuser':
    case 'pg_dropcluster':
      v.ask(`${bin} apaga dados do banco; confirme o alvo (nunca produção).`);
      break;
    case 'drizzle-kit':
      if (args.some((a) => /^(?:push|drop|migrate|up)$/.test(a))) {
        v.ask(
          'drizzle-kit push/drop/migrate altera o banco fora do fluxo de migrações versionadas; use o runner do @salon/db e confirme o alvo.',
        );
      }
      break;
    case 'supabase':
      if (args.includes('db') && args.includes('reset') && args.includes('--linked')) {
        v.deny('supabase db reset --linked apaga o banco REMOTO.');
      } else if (args.includes('db') && (args.includes('reset') || args.includes('push'))) {
        v.ask('Operação destrutiva de banco (supabase db reset/push); confirme o alvo.');
      }
      break;
    case 'prisma':
      if (
        (args.includes('migrate') && args.includes('reset')) ||
        (args.includes('db') &&
          args.includes('push') &&
          args.some((a) => /force-reset|accept-data-loss/.test(a)))
      ) {
        v.ask('Operação destrutiva de banco (prisma); confirme o alvo.');
      }
      break;
    case 'sequelize':
      if (args.some((a) => /^db:drop/.test(a))) v.ask('sequelize db:drop apaga o banco; confirme.');
      break;
    case 'pnpm':
      checkPnpm(args, v);
      break;
    case 'npm':
      checkNpm(args, v);
      break;
    case 'yarn':
      if (args[0] === 'add' || args[0] === 'install' || args[0] === 'i') {
        v.ask(`Este repositório usa pnpm; ${bin} ${args[0]} criaria outro lockfile. Confirme.`);
      }
      break;
    case 'pip':
    case 'pip3':
    case 'pipx':
    case 'uv':
    case 'uvx':
    case 'cargo':
    case 'go':
    case 'gem':
    case 'brew':
    case 'apt':
    case 'apt-get':
    case 'yum':
    case 'dnf':
    case 'apk':
    case 'snap':
    case 'conda':
      if (
        args.some((a) => /^(?:install|add|get|run)$/.test(a)) ||
        bin === 'uvx' ||
        bin === 'pipx'
      ) {
        v.ask(
          `Instalação de pacote (${bin}); confirme versão fixa, reputação e quarentena (>= 3 dias) antes de adicionar dependência.`,
        );
      }
      break;
    case 'corepack':
      if (args.some((a) => /^(?:enable|disable|prepare|use|install|up)$/.test(a))) {
        v.ask(
          'corepack altera o gerenciador de pacotes ativo; confirme a versão (packageManager do package.json).',
        );
      }
      break;
    case 'vercel':
    case 'netlify':
      if (args.some((a) => /^(?:--prod|deploy|promote|rollback|rm|remove|alias|env)$/.test(a))) {
        v.ask(`Deploy/alteração remota (${bin}); confirme.`);
      }
      break;
    case 'fly':
    case 'flyctl':
      if (args.some((a) => /^(?:deploy|destroy|secrets|scale|apps)$/.test(a)))
        v.ask(`Deploy/alteração remota (${bin}); confirme.`);
      break;
    case 'terraform':
    case 'tofu':
      if (args.some((a) => /^(?:apply|destroy|import|state|taint|untaint)$/.test(a)))
        v.ask(`Alteração de infraestrutura (${bin}); confirme.`);
      break;
    case 'pulumi':
      if (args.some((a) => /^(?:up|update|destroy|refresh|import)$/.test(a)))
        v.ask('Alteração de infraestrutura (pulumi); confirme.');
      break;
    case 'kubectl':
      if (
        args.some((a) =>
          /^(?:apply|delete|create|replace|patch|scale|rollout|drain|cordon|edit|exec|set)$/.test(
            a,
          ),
        )
      ) {
        v.ask('Alteração em cluster Kubernetes; confirme.');
      }
      break;
    case 'helm':
      if (args.some((a) => /^(?:install|upgrade|uninstall|rollback|delete)$/.test(a)))
        v.ask('Alteração em cluster (helm); confirme.');
      break;
    case 'docker':
    case 'podman':
      if (args.some((a) => /^(?:push|login)$/.test(a)))
        v.ask(`${bin} ${args.join(' ')}: publica imagem ou usa credenciais; confirme.`);
      break;
    case 'aws':
      if (
        (args.includes('configure') && args.some((a) => /^(?:get|export-credentials)$/.test(a))) ||
        (args.includes('sts') && args.some((a) => /get-session-token|assume-role/.test(a)))
      ) {
        v.deny('Imprimir credenciais da AWS é proibido.');
      }
      break;
    case 'gcloud':
      if (args.some((a) => /^print-(?:access|identity)-token$/.test(a)))
        v.deny('Imprimir tokens do gcloud é proibido.');
      break;
    case 'az':
      if (args.includes('get-access-token')) v.deny('Imprimir tokens do Azure é proibido.');
      break;
    case 'op':
      if (args[0] === 'read' || (args[0] === 'item' && args[1] === 'get'))
        v.deny('Ler segredos do 1Password é proibido.');
      break;
    case 'security':
      if (args.some((a) => /^find-(?:generic|internet)-password$/.test(a)))
        v.deny('Ler senhas do Keychain é proibido.');
      break;
    case 'vault':
    case 'doppler':
    case 'heroku':
      if (args.some((a) => /^(?:read|get|kv|secrets|auth:token)$/.test(a)))
        v.deny(`Ler segredos via ${bin} é proibido.`);
      break;
    case 'ssh':
      v.ask('Comando remoto via ssh; confirme o destino.');
      break;
    case 'claude':
      if (args.some((a) => a === '--dangerously-skip-permissions' || a === 'bypassPermissions')) {
        v.deny('Iniciar o Claude Code sem permissões é proibido.');
      }
      break;
    case 'lefthook':
      if (args[0] === 'uninstall') v.ask('lefthook uninstall remove os hooks git; confirme.');
      break;
    case 'mkfs':
    case 'fdisk':
    case 'sfdisk':
    case 'parted':
    case 'wipefs':
    case 'mkswap':
      v.deny('Comando de disco destrutivo bloqueado.');
      break;
    default:
      if (/^mkfs\./.test(bin)) v.deny('Comando de disco destrutivo bloqueado.');
      if (STDIN_INTERPRETERS.has(bin)) checkPipeIntoInterpreter(cmd, all, v);
  }
}

/**
 * Índices dos argumentos que são padrão/script (grep, rg, sed, awk, jq), e não caminho.
 * `grep -n ".env" README.md` procura o texto ".env"; não lê o arquivo .env.
 * @param {string} bin
 * @param {string[]} args
 * @returns {number[]}
 */
function patternArgumentIndexes(bin, args) {
  const grepLike = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'zgrep']);
  const awkLike = new Set(['awk', 'gawk', 'mawk']);
  const sedLike = new Set(['sed', 'gsed']);
  const jqLike = new Set(['jq', 'yq']);
  if (!grepLike.has(bin) && !awkLike.has(bin) && !sedLike.has(bin) && !jqLike.has(bin)) return [];
  // Com -e o padrão/script vem na opção (e só ele é texto); os posicionais são caminhos.
  /** @type {number[]} */
  const fromOptions = [];
  args.forEach((a, k) => {
    if (a === '-e' || a === '--regexp' || a === '--expression') fromOptions.push(k + 1);
  });
  if (
    fromOptions.length > 0 ||
    args.some((a) => a === '-f' || a === '--file' || /^--(?:regexp|expression|file)=/.test(a))
  ) {
    return fromOptions;
  }
  /** @type {Record<string, number>} quantos argumentos cada opção consome */
  const consumes = {};
  if (grepLike.has(bin)) {
    for (const o of [
      '-A',
      '-B',
      '-C',
      '-m',
      '-d',
      '-D',
      '-g',
      '--glob',
      '-t',
      '--type',
      '-T',
      '--type-not',
      '-M',
    ]) {
      consumes[o] = 1;
    }
    for (const o of ['--max-columns', '--max-count', '--max-depth', '--colors']) consumes[o] = 1;
  }
  if (awkLike.has(bin)) {
    consumes['-F'] = 1;
    consumes['-v'] = 1;
  }
  if (jqLike.has(bin)) {
    for (const o of ['--arg', '--argjson', '--slurpfile', '--rawfile']) consumes[o] = 2;
    consumes['--indent'] = 1;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') return i + 1 < args.length ? [i + 1] : [];
    if (a.startsWith('-') && a !== '-') {
      i += consumes[a] ?? 0;
      continue;
    }
    return [i];
  }
  return [];
}

/**
 * @param {string} bin
 * @param {string[]} args
 */
function secretMentionsAllowed(bin, args) {
  if (bin === 'git') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (sub === 'check-ignore' || sub === 'ls-files' || sub === 'status') return true;
    if (sub === 'rm' && args.includes('--cached')) return true;
    return false;
  }
  if (bin === 'find') {
    return !args.some((a) =>
      /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a),
    );
  }
  if (bin === 'dotenv' || bin === 'dotenvx' || bin === 'env-cmd') return true;
  return false;
}

/**
 * @param {string} value
 * @param {PolicyContext} ctx
 * @returns {boolean}
 */
function isDangerousDeleteTarget(value, ctx) {
  // Raiz, home, diretório atual ou pai, e globs que os cobrem por inteiro.
  if (/^(?:\/+|\/\*|~\/?|~\/\*|\*|\.\*|\.\/?|\.\/\*|\.\.\/?|\.\.\/\*)$/.test(value)) return true;
  const trimmed = value.replace(/\/+$/, '') || '/';
  if (path.posix.basename(trimmed) === '.git') return true;
  if (trimmed.startsWith('~')) return false; // subpasta da home: pede confirmação em checkRm
  const abs = path.resolve(ctx.cwd, trimmed);
  const project = path.resolve(ctx.projectDir);
  // O próprio projeto ou um diretório que o contém.
  if (abs === project || project.startsWith(`${abs}${path.sep}`)) return true;
  if (abs === '/tmp' || abs === '/private/tmp') return true;
  // Raiz de diretório de usuário (/home, /home/<u>, /Users/<u>, /root).
  if (/^\/(?:home|Users)(?:\/[^/]+)?$/.test(abs) || abs === '/root') return true;
  const userArea =
    /^\/(?:home\/[^/]+|Users\/[^/]+|root|tmp|private\/tmp|var\/folders)\//.test(abs) ||
    abs.startsWith(`${project}${path.sep}`);
  return SYSTEM_DIRS.test(abs) && !userArea;
}

/**
 * Artefato de build dentro do projeto (node_modules, dist, .next...) ou item em /tmp.
 * @param {string} value
 * @param {PolicyContext} ctx
 */
function isSafeDeleteTarget(value, ctx) {
  const trimmed = value.replace(/\/+$/, '');
  if (trimmed.startsWith('~')) return false;
  const abs = path.resolve(ctx.cwd, trimmed);
  if (/^\/(?:tmp|private\/tmp)\/[^/]+/.test(abs)) return true;
  // Artefatos de build só são "seguros" dentro do projeto.
  const rel = path.relative(path.resolve(ctx.projectDir), abs).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const segments = rel.split('/');
  if (segments.some((s) => s === 'node_modules' || s === '.turbo' || s === '.next')) return true;
  return SAFE_DELETE_BASENAMES.has(path.posix.basename(rel));
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkRm(bin, args, dynamic, ctx, v) {
  let recursive = bin === 'rimraf';
  let endOfOptions = false;
  /** @type {Array<{ value: string, dynamic: boolean }>} */
  const targets = [];
  args.forEach((a, k) => {
    if (!endOfOptions && a === '--') {
      endOfOptions = true;
      return;
    }
    if (!endOfOptions && a.startsWith('--')) {
      if (a === '--recursive') recursive = true;
      return;
    }
    if (!endOfOptions && /^-[A-Za-z]+$/.test(a)) {
      if (/[rR]/.test(a)) recursive = true;
      return;
    }
    targets.push({ value: a, dynamic: dynamic[k] ?? false });
  });
  if (!recursive) return;
  for (const target of targets) {
    if (target.dynamic) {
      if (/^\$\{?HOME\}?\/?\*?$/.test(target.value)) {
        v.deny(`rm recursivo no diretório do usuário (${target.value}).`);
      } else {
        v.ask(
          `rm recursivo com alvo dinâmico (${target.value}); se a variável estiver vazia o alvo muda. Confirme.`,
        );
      }
      continue;
    }
    if (isDangerousDeleteTarget(target.value, ctx)) {
      v.deny(`rm recursivo em alvo perigoso (${target.value}).`);
    } else if (!isSafeDeleteTarget(target.value, ctx)) {
      v.ask(`rm recursivo fora de artefatos de build (${target.value}); confirme.`);
    }
  }
}

/**
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkFind(args, dynamic, cmd, all, ctx, depth, v) {
  /** @type {string[]} */
  const roots = [];
  for (const a of args) {
    if (a.startsWith('-') || a === '(' || a === '!' || a === ')') break;
    roots.push(a);
  }
  if (roots.length === 0) roots.push('.');
  if (args.includes('-delete')) {
    const filtered = args.some((a) =>
      /^-(?:i?name|i?path|i?regex|type|newer|mtime|mmin|size|empty|user|perm)$/.test(a),
    );
    if (roots.some((r) => isDangerousDeleteTarget(r, ctx)) && !filtered) {
      v.deny(`find -delete sem filtro em alvo perigoso (${roots.join(' ')}).`);
    } else {
      v.ask('find -delete apaga arquivos; confirme o filtro e o diretório.');
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i] ?? '')) continue;
    let j = i + 1;
    /** @type {string[]} */
    const inner = [];
    /** @type {boolean[]} */
    const innerDynamic = [];
    while (j < args.length && args[j] !== ';' && args[j] !== '+') {
      const word = args[j] ?? '';
      inner.push(word);
      innerDynamic.push((dynamic[j] ?? false) || word.includes('{}'));
      j++;
    }
    if (inner.length > 0) analyzeArgv(inner, innerDynamic, cmd, all, ctx, depth + 1, v);
    i = j;
  }
}

/**
 * Modo e alvos de chmod/chown/chgrp/chattr. Modos simbólicos que começam com `-`
 * (`chmod -x arquivo`, `chattr -i arquivo`) não são opções; `--reference=ARQ` dispensa o
 * modo, e então todos os operandos são alvos.
 * @param {string} bin
 * @param {string[]} args
 * @returns {{ mode: string, targets: string[] }}
 */
function modeChangeOperands(bin, args) {
  const modeLike =
    bin === 'chmod' ? /^-[rwxXst]+$/ : bin === 'chattr' ? /^-[aAcCdDeFijmPsStTux]+$/ : null;
  /** @type {string[]} */
  const operands = [];
  let reference = false;
  let endOfOptions = false;
  for (const arg of args) {
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith('--')) {
      if (arg.startsWith('--reference')) reference = true;
      continue;
    }
    const isModeOperand = operands.length === 0 && !reference && modeLike?.test(arg) === true;
    if (!endOfOptions && arg.startsWith('-') && arg !== '-' && !isModeOperand) continue;
    operands.push(arg);
  }
  if (reference) return { mode: '', targets: operands };
  return { mode: operands[0] ?? '', targets: operands.slice(1) };
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkChmod(bin, args, ctx, v) {
  const recursive = args.some((a) => a === '-R' || a === '--recursive' || /^-[a-zA-Z]*R/.test(a));
  const { mode, targets } = modeChangeOperands(bin, args);
  if (
    bin === 'chmod' &&
    (/^0?[0-7]?77[67]$/.test(mode) ||
      (/(?:^|,)(?:a|o|ugo)?\+[rwx]*w/.test(mode) && /(?:^|,)(?:a|o)\+/.test(mode)))
  ) {
    v.deny(`chmod ${mode} deixa arquivos graváveis por todos; use permissões mínimas.`);
  }
  if (recursive && targets.some((t) => isDangerousDeleteTarget(t, ctx))) {
    v.deny(`${bin} recursivo em alvo perigoso.`);
  }
}

/**
 * @param {string} name
 */
function isProtectedBranch(name) {
  return /^(?:main|master)$/i.test(name);
}

/**
 * @param {string} ref
 */
function normalizeBranchRef(ref) {
  return ref.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
}

/**
 * @param {string[]} args
 * @param {boolean[]} _dynamic
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkGit(args, _dynamic, ctx, v) {
  let gitCwd = ctx.cwd;
  /** @type {string[]} */
  const configs = [];
  const valueOpts = new Set([
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--super-prefix',
    '--exec-path',
    '--list-cmds',
    '--attr-source',
  ]);
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '-C') {
      gitCwd = path.resolve(gitCwd, args[i + 1] ?? '.');
      i += 2;
      continue;
    }
    if (a === '-c') {
      configs.push(args[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (a.startsWith('--config-env=')) {
      configs.push(a.slice('--config-env='.length));
      i++;
      continue;
    }
    if (valueOpts.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    break;
  }
  for (const c of configs) {
    if (/^core\.hookspath\b/i.test(c)) {
      v.deny(
        'git -c core.hooksPath=... desliga os hooks do repositório; não contorne verificações.',
      );
    } else if (/^alias\./i.test(c)) {
      v.ask('git -c alias.* define comando ad hoc; confirme.');
    }
  }
  const sub = args[i];
  if (sub === undefined) return;
  const rest = args.slice(i + 1);
  if (rest.includes('--no-verify')) {
    v.deny(
      'git --no-verify é proibido: não pule hooks nem verificações; corrija a causa da falha.',
    );
  }
  // `--output` (diff, log, show, format-patch...) grava num arquivo arbitrário: fora de
  // /tmp pede confirmação (git diff/log estão pré-aprovados nas permissões).
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? '';
    const m = /^--output(?:-directory)?=(.*)$/.exec(a);
    let target = null;
    if (m) target = m[1] ?? '';
    else if ((a === '--output' || a === '--output-directory') && rest[k + 1] !== undefined) {
      target = rest[k + 1] ?? '';
    }
    if (target === null) continue;
    checkWriteTarget(target, ctx, v, `git ${sub} --output`);
    const abs = path.resolve(gitCwd, target);
    if (!/^\/(?:tmp|private\/tmp)\//.test(abs) && abs !== '/dev/null') {
      v.ask(`git ${sub} --output grava em ${target}; confirme.`);
    }
  }
  switch (sub) {
    case 'push':
      checkGitPush(rest, gitCwd, ctx, v);
      break;
    case 'commit':
      checkGitCommitShortFlags(rest, v);
      break;
    case 'reset':
      if (rest.includes('--hard'))
        v.ask('git reset --hard descarta trabalho não commitado; confirme.');
      break;
    case 'clean':
      if (rest.some((a) => a === '--force' || /^-[a-zA-Z]*f/.test(a))) {
        v.ask('git clean -f apaga arquivos não rastreados; confirme.');
      }
      break;
    case 'checkout': {
      const discards =
        rest.includes('-f') ||
        rest.includes('--force') ||
        /^(?:\.|\*|:\/)$/.test(rest.at(-1) ?? '') ||
        (rest.includes('--') &&
          rest.slice(rest.indexOf('--') + 1).some((p) => p === '.' || p === '*'));
      if (discards) v.ask('Descartar mudanças locais (git checkout); confirme.');
      checkGitPathWrites(rest, ctx, v);
      break;
    }
    case 'restore': {
      const onlyStaged =
        rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W');
      if (!onlyStaged && rest.some((p) => p === '.' || p === '*' || p === ':/')) {
        v.ask('git restore descarta mudanças locais; confirme.');
      }
      checkGitPathWrites(rest, ctx, v);
      break;
    }
    case 'switch':
      if (rest.some((a) => a === '-f' || a === '--force' || a === '--discard-changes')) {
        v.ask('git switch descartando mudanças locais; confirme.');
      }
      break;
    case 'stash':
      if (rest[0] === 'drop' || rest[0] === 'clear') v.ask('Remover stash; confirme.');
      break;
    case 'branch':
      if (
        rest.some((a) => a === '-D' || a === '-M' || a === '-C') ||
        (rest.includes('--delete') && rest.includes('--force')) ||
        ((rest.includes('-d') || rest.includes('--delete')) && rest.some(isProtectedBranch))
      ) {
        v.ask('Remoção/renomeação forçada de branch; confirme.');
      }
      break;
    case 'add':
      if (rest.some((a) => a === '-f' || a === '--force' || /^-[a-zA-Z]*f/.test(a))) {
        v.ask('git add --force adiciona arquivo ignorado (pode ser segredo); confirme.');
      }
      break;
    case 'filter-branch':
    case 'filter-repo':
    case 'replace':
      v.ask('Reescrita de histórico; confirme.');
      break;
    case 'update-ref':
      if (rest.includes('-d') || rest.includes('--delete')) v.ask('Remoção de ref; confirme.');
      break;
    case 'reflog':
      if (rest[0] === 'expire' || rest[0] === 'delete')
        v.ask('Apagar reflog remove a rede de segurança; confirme.');
      break;
    case 'gc':
      if (rest.some((a) => a.startsWith('--prune=now') || a === '--prune=all'))
        v.ask('git gc --prune=now; confirme.');
      break;
    case 'config': {
      const key = rest.find((a) => !a.startsWith('-')) ?? '';
      if (/^core\.hookspath$/i.test(key) && !rest.includes('--unset') && !rest.includes('--get')) {
        v.deny('Alterar core.hooksPath desliga os hooks do repositório; proibido.');
      } else if (/^(?:alias\.|credential\.)/i.test(key) && !rest.includes('--get')) {
        v.ask(`git config ${key}: confirme.`);
      } else if (rest.includes('--global') || rest.includes('--system')) {
        v.ask('Alteração de configuração global do git; confirme.');
      }
      break;
    }
    case 'credential':
    case 'credential-store':
    case 'credential-cache':
      v.deny('git credential expõe credenciais; proibido.');
      break;
    default:
      break;
  }
}

/**
 * `git checkout <ref> -- <paths>` e `git restore` sobrescrevem arquivos.
 * @param {string[]} rest
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkGitPathWrites(rest, ctx, v) {
  const dd = rest.indexOf('--');
  const paths = dd >= 0 ? rest.slice(dd + 1) : rest.filter((a) => !a.startsWith('-')).slice(1);
  for (const p of paths) checkWriteTarget(p, ctx, v, 'git checkout/restore');
}

/**
 * `-n` em `git commit` equivale a `--no-verify`.
 * @param {string[]} rest
 * @param {Verdict} v
 */
function checkGitCommitShortFlags(rest, v) {
  const longWithValue = new Set([
    '--message',
    '--file',
    '--reuse-message',
    '--reedit-message',
    '--fixup',
    '--squash',
    '--author',
    '--date',
    '--cleanup',
    '--trailer',
    '--template',
  ]);
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? '';
    if (a === '--') break;
    if (a.startsWith('--')) {
      if (longWithValue.has(a)) k++;
      continue;
    }
    if (!/^-[A-Za-z]+$/.test(a)) continue;
    for (let c = 1; c < a.length; c++) {
      const flag = a.charAt(c);
      if (flag === 'n') {
        v.deny('git commit -n (--no-verify) é proibido: não pule os hooks.');
        return;
      }
      if ('mFCct'.includes(flag)) {
        if (c === a.length - 1) k++;
        break;
      }
    }
  }
}

/**
 * @param {string[]} rest
 * @param {string} gitCwd
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkGitPush(rest, gitCwd, ctx, v) {
  let force = false;
  let lease = false;
  let del = false;
  let all = false;
  let mirror = false;
  /** @type {string[]} */
  const positionals = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? '';
    if (a === '--') {
      positionals.push(...rest.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      if (name === '--force') force = true;
      else if (name === '--force-with-lease' || name === '--force-if-includes') lease = true;
      else if (name === '--delete') del = true;
      else if (name === '--all' || name === '--branches') all = true;
      else if (name === '--mirror') mirror = true;
      else if (
        ['--repo', '--receive-pack', '--exec', '--push-option'].includes(name ?? '') &&
        !a.includes('=')
      )
        k++;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(a)) {
      if (a.includes('f')) force = true;
      if (a.includes('d')) del = true;
      if (a.endsWith('o')) k++;
      continue;
    }
    positionals.push(a);
  }
  if (force) {
    v.deny(
      'git push --force é proibido (reescreve o histórico remoto). Faça um commit novo; --force-with-lease só com confirmação humana e nunca em branch protegida.',
    );
  }
  if (mirror) v.deny('git push --mirror sobrescreve todas as refs remotas; proibido.');
  if (lease)
    v.ask(
      'git push --force-with-lease reescreve a branch remota: confirme que a branch é sua e não é protegida.',
    );
  if (all) v.ask('git push --all envia todas as branches locais (inclusive main); confirme.');
  const refspecs = positionals.slice(1);
  const branch = ctx.currentBranch(gitCwd);
  if (refspecs.length === 0) {
    if (!all && !mirror && branch && isProtectedBranch(branch)) {
      v.deny(`Push da branch ${branch} (protegida) é proibido; trabalhe numa branch e abra um PR.`);
    }
    return;
  }
  for (const raw of refspecs) {
    let spec = raw;
    if (spec.startsWith('+')) {
      v.deny(`Refspec com "+" (${raw}) força o push; proibido.`);
      spec = spec.slice(1);
    }
    const colon = spec.indexOf(':');
    if (colon === 0 || del) {
      const target = normalizeBranchRef(colon === 0 ? spec.slice(1) : spec);
      if (isProtectedBranch(target)) v.deny(`Apagar a branch remota ${target} é proibido.`);
      else v.ask(`git push removendo a ref remota ${target}; confirme.`);
      continue;
    }
    let dst = colon > 0 ? spec.slice(colon + 1) : spec;
    if (colon < 0 && (spec === 'HEAD' || spec === '@')) dst = branch ?? spec;
    const name = normalizeBranchRef(dst);
    if (isProtectedBranch(name)) {
      v.deny(`Push direto para ${name} é proibido; abra um PR a partir de uma branch de trabalho.`);
    }
  }
}

/**
 * @param {string[]} args
 * @param {Verdict} v
 */
function checkGh(args, v) {
  const [group, action] = args;
  if (group === 'auth' && action === 'token') v.deny('Não exponha o token do gh.');
  if (
    group === 'auth' &&
    action === 'status' &&
    args.some((a) => a === '-t' || a === '--show-token')
  ) {
    v.deny('Não exponha o token do gh.');
  }
  if (group === 'pr' && action === 'merge')
    v.ask('gh pr merge: merge exige revisão humana; confirme.');
  if (group === 'release' && /^(?:create|delete|edit|upload)$/.test(action ?? ''))
    v.ask('Publicação de release; confirme.');
  if (
    (group === 'secret' || group === 'variable') &&
    /^(?:set|delete|remove)$/.test(action ?? '')
  ) {
    v.ask(`gh ${group} ${action} altera segredos/variáveis do repositório; confirme.`);
  }
  if (group === 'repo' && /^(?:delete|edit|rename|archive|transfer)$/.test(action ?? '')) {
    v.ask(`gh repo ${action} altera o repositório remoto; confirme.`);
  }
  if (group === 'workflow' && /^(?:run|enable|disable)$/.test(action ?? ''))
    v.ask(`gh workflow ${action}; confirme.`);
  if (group === 'extension' && action === 'install')
    v.ask('gh extension install executa código de terceiros; confirme.');
  if ((group === 'ssh-key' || group === 'gpg-key') && /^(?:add|delete)$/.test(action ?? '')) {
    v.ask(`gh ${group} ${action} altera chaves da conta; confirme.`);
  }
  if (group === 'api') {
    const method = args.find((_a, k) => args[k - 1] === '-X' || args[k - 1] === '--method') ?? '';
    const mutates =
      /^(?:POST|PUT|PATCH|DELETE)$/i.test(method) ||
      args.some((a) => /^--method=(?:POST|PUT|PATCH|DELETE)$/i.test(a)) ||
      args.some(
        (a) =>
          a === '-f' || a === '-F' || a === '--field' || a === '--raw-field' || a === '--input',
      );
    if (mutates) v.ask('gh api com método de escrita; confirme.');
  }
}

/**
 * @param {string[]} args
 * @param {Verdict} v
 */
function checkPnpm(args, v) {
  const { sub, index } = pnpmSubcommand(args);
  if (sub === null) return;
  const rest = args.slice(index + 1);
  const positionals = rest.filter((a) => !a.startsWith('-'));
  const depMessage =
    'Dependência nova ou atualizada: confirme quarentena (>= 3 dias, minimumReleaseAge), reputação, licença e scripts de instalação; rode sob flock.';
  switch (sub) {
    case 'add':
      v.ask(depMessage);
      break;
    case 'install':
    case 'i':
      if (
        positionals.length > 0 ||
        rest.some((a) =>
          /^(?:--no-frozen-lockfile|--fix-lockfile|--force|--lockfile-only|-g|--global)$/.test(a),
        )
      ) {
        v.ask(depMessage);
      }
      break;
    case 'update':
    case 'up':
    case 'upgrade':
      v.ask(depMessage);
      break;
    case 'approve-builds':
    case 'rebuild':
      v.ask(
        'Liberar scripts de build de dependências executa código de terceiros; confirme (allowBuilds no pnpm-workspace.yaml).',
      );
      break;
    case 'config':
      if (rest[0] === 'set' || rest[0] === 'delete')
        v.ask('pnpm config set altera configuração de supply chain; confirme.');
      break;
    case 'publish':
      v.ask('Publicação de pacote; confirme.');
      break;
    case 'patch':
    case 'patch-commit':
    case 'patch-remove':
      v.ask('Patch em dependência de terceiros; confirme.');
      break;
    case 'run':
    case 'run-script':
      if (DB_SCRIPT.test(positionals[0] ?? '')) {
        v.ask(
          `Script "${positionals[0]}" roda contra banco/ambiente real; confirme o alvo (nunca produção).`,
        );
      }
      break;
    case 'deploy':
      v.ask('pnpm deploy empacota e publica um pacote; confirme.');
      break;
    default:
      break;
  }
}

/**
 * @param {string[]} args
 * @param {Verdict} v
 */
function checkNpm(args, v) {
  const sub = args.find((a) => !a.startsWith('-')) ?? '';
  if (/^(?:install|i|add|ci|update|up|link)$/.test(sub)) {
    v.ask(
      'Este repositório usa pnpm (npm criaria package-lock.json e ignoraria a quarentena). Confirme.',
    );
  }
  if (sub === 'publish' || sub === 'unpublish' || sub === 'deprecate')
    v.ask('Publicação de pacote; confirme.');
  if (sub === 'token') v.deny('npm token expõe credenciais do registro.');
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isDestructiveSql(text) {
  const clean = String(text)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const statement of clean.split(';')) {
    const s = statement.trim();
    if (s === '') continue;
    if (
      /^DROP\s+(?:DATABASE|SCHEMA|TABLE|ROLE|USER|POLICY|EXTENSION|OWNED|FUNCTION|VIEW|MATERIALIZED\s+VIEW|TYPE|TRIGGER|SEQUENCE|INDEX)\b/i.test(
        s,
      )
    ) {
      return true;
    }
    if (/^TRUNCATE\b/i.test(s)) return true;
    if (/^DELETE\s+FROM\b/i.test(s) && !/\bWHERE\b/i.test(s)) return true;
    if (/^UPDATE\b[\s\S]*\bSET\b/i.test(s) && !/\bWHERE\b/i.test(s)) return true;
    if (/^ALTER\s+TABLE\b[\s\S]*\b(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i.test(s))
      return true;
    if (/^ALTER\s+TABLE\b[\s\S]*\bDROP\s+(?:COLUMN|CONSTRAINT)\b/i.test(s)) return true;
    if (/^ALTER\s+(?:ROLE|USER)\b[\s\S]*\b(?:SUPERUSER|BYPASSRLS)\b/i.test(s)) return true;
    if (/^GRANT\b[\s\S]*\bTO\s+PUBLIC\b/i.test(s)) return true;
    if (/^SET\s+(?:SESSION\s+)?row_security\s*(?:=|TO)\s*off\b/i.test(s)) return true;
  }
  return false;
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {SimpleCommand} cmd
 * @param {Verdict} v
 */
function checkDbClient(bin, args, cmd, v) {
  /** @type {string[]} */
  const sql = [...cmd.hereStrings, ...cmd.heredocs.map((h) => h.body)];
  const valueFlags = {
    psql: ['-c', '--command'],
    pgcli: ['-c'],
    mysql: ['-e', '--execute'],
    mariadb: ['-e', '--execute'],
    mongosh: ['--eval'],
    mongo: ['--eval'],
  };
  const flags = /** @type {Record<string, string[]>} */ (valueFlags)[bin] ?? [];
  args.forEach((a, k) => {
    if (flags.includes(a) && args[k + 1] !== undefined) sql.push(args[k + 1] ?? '');
    for (const f of flags) if (a.startsWith(`${f}=`)) sql.push(a.slice(f.length + 1));
    if (bin === 'psql' && /^-c./.test(a)) sql.push(a.slice(2));
  });
  if (bin === 'sqlite3') sql.push(...args.filter((a) => !a.startsWith('-')).slice(1));
  if (bin === 'redis-cli' && args.some((a) => /^(?:FLUSHALL|FLUSHDB)$/i.test(a))) {
    v.ask('redis-cli FLUSHALL/FLUSHDB apaga dados; confirme o alvo.');
  }
  if (sql.some((s) => /\b(?:dropDatabase|deleteMany\(\s*\{\s*\}\s*\)|\.drop\(\))/.test(s))) {
    v.ask('Comando destrutivo no banco; confirme o alvo.');
  }
  if (sql.some(isDestructiveSql)) {
    v.ask(
      'SQL destrutivo (DROP/TRUNCATE/DELETE ou UPDATE sem WHERE/DISABLE RLS/BYPASSRLS); confirme o banco alvo.',
    );
  }
  const remote = args.some((a, k) => {
    const url =
      /^(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss):\/\/(?:[^@/]*@)?\[?([^\]/:?]+)/i.exec(
        a,
      );
    if (url?.[1] && !isLocalHost(url[1])) return true;
    if ((a === '-h' || a === '--host') && args[k + 1] && !isLocalHost(args[k + 1] ?? ''))
      return true;
    const m = /^--host=(.+)$/.exec(a);
    return Boolean(m?.[1] && !isLocalHost(m[1]));
  });
  if (remote) v.ask('Conexão a banco remoto; confirme que não é produção.');
}

/**
 * @param {string} host
 */
function isLocalHost(host) {
  return (
    /^(?:localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|host\.docker\.internal|postgres|db)$/i.test(
      host,
    ) || host.startsWith('/')
  );
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {PolicyContext} _ctx
 * @param {number} _depth
 * @param {Verdict} v
 */
function checkInterpreter(bin, args, dynamic, cmd, all, _ctx, _depth, v) {
  /** @type {Record<string, string[]>} */
  const inlineFlags = {
    node: ['-e', '--eval', '-p', '--print'],
    tsx: ['-e', '--eval', '-p', '--print'],
    'ts-node': ['-e', '--eval', '-p', '--print'],
    bun: ['-e', '--eval', '-p', '--print'],
    python: ['-c'],
    python3: ['-c'],
    python2: ['-c'],
    perl: ['-e', '-E'],
    ruby: ['-e'],
    php: ['-r'],
  };
  const flags = inlineFlags[bin] ?? [];
  let hasInline = false;
  let hasScript = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? '';
    const eq = flags.find((f) => a.startsWith(`${f}=`));
    if (flags.includes(a) || eq) {
      hasInline = true;
      const code = eq ? a.slice(eq.length + 1) : (args[k + 1] ?? '');
      if (!eq && dynamic[k + 1]) v.ask(`${bin} ${a} com código dinâmico; confirme.`);
      checkInlineCode(code, v);
      if (!eq) k++;
      continue;
    }
    if (bin === 'deno' && a === 'eval') {
      hasInline = true;
      checkInlineCode(args[k + 1] ?? '', v);
      k++;
      continue;
    }
    if (!a.startsWith('-')) {
      hasScript = a !== '-';
      break;
    }
  }
  if (!hasInline && !hasScript) {
    for (const heredoc of cmd.heredocs) checkInlineCode(heredoc.body, v);
    if (cmd.heredocs.length === 0) checkPipeIntoInterpreter(cmd, all, v);
  }
}

/**
 * Regras para código passado inline (`node -e`, `python -c`...).
 * @param {string} code
 * @param {Verdict} v
 */
function checkInlineCode(code, v) {
  if (/process\.env(?!\s*(?:\.\s*[A-Za-z_$]|\[\s*['"`]))/.test(code)) {
    v.deny('Despejar process.env inteiro expõe segredos.');
  }
  for (const m of code.matchAll(
    /process\.env\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"`]([^'"`]+)['"`]\s*\])/g,
  )) {
    const name = m[1] ?? m[2] ?? '';
    if (isSensitiveVarName(name))
      v.deny(`Acesso a variável sensível (${name}) em código inline bloqueado.`);
  }
  if (
    /\bos\.environ\b(?!\s*(?:\[|\.get\s*\())/.test(code) ||
    /%ENV\b/.test(code) ||
    /\bDeno\.env\.toObject\s*\(/.test(code)
  ) {
    v.deny('Despejar o ambiente inteiro em código inline expõe segredos.');
  }
  for (const m of code.matchAll(
    /(?:os\.environ\s*\[\s*|os\.environ\.get\s*\(\s*|os\.getenv\s*\(\s*|ENV\s*\[\s*|ENV\.fetch\s*\(\s*|\$ENV\{\s*|Deno\.env\.get\s*\(\s*)['"]?([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    const name = m[1] ?? '';
    if (isSensitiveVarName(name))
      v.deny(`Acesso a variável sensível (${name}) em código inline bloqueado.`);
  }
  if (
    /\bchild_process\b|\bexecSync\s*\(|\bspawnSync\s*\(|\bexecFileSync\s*\(|\bsubprocess\b|\bos\.system\s*\(|\bos\.popen\s*\(|\bBun\.spawn|\bDeno\.(?:Command|run)\b|\bProcessBuilder\b|\bshell_exec\s*\(|\bpassthru\s*\(/.test(
      code,
    )
  ) {
    v.ask('Código inline que executa comandos de shell; confirme o que será executado.');
  }
  for (const m of code.matchAll(/['"`]([^'"`\n]{1,300})['"`]/g)) {
    for (const candidate of pathCandidates(m[1] ?? '')) {
      const secret = classifySecretPath(candidate);
      if (secret) {
        v.deny(`Código inline acessando ${secret.reason} bloqueado.`);
        return;
      }
    }
  }
}
