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
 * - Acompanha o estado do script: `cd`/`pushd` (o alvo relativo de uma escrita é avaliado
 *   contra todos os diretórios possíveis) e variáveis atribuídas no próprio comando
 *   (`X=.env; cat $X`). Na dúvida (cd para destino dinâmico, argumento dinâmico de leitor),
 *   pede confirmação.
 *
 * Isto é defesa em profundidade, não sandbox: um script local (`node x.mjs`), código com
 * nomes montados em tempo de execução (`'.e' + 'nv'`) ou um binário desconhecido podem fazer
 * o que quiserem. As regras de permissão e o sandbox do sistema operacional são as outras
 * camadas (ver "Limites conhecidos" em .claude/README.md).
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalInterpreter,
  gitOptionTakesValue,
  interpreterFamily,
  parseInPlaceInterpreter,
  parseInterpreterArgs,
  parseShellArgs,
  resolveGitLongOption,
} from './cli-options.mjs';
import {
  existsOnDefaultBranch,
  currentBranch as gitCurrentBranch,
  pushConfig as gitPushConfig,
} from './git.mjs';
import {
  classifySecretPath,
  collapseWildcards,
  dotGlobReachesSecret,
  isLockfile,
  isMigrationPath,
  pathCandidates,
  protectedConfigLevel,
  protectedGlobMatch,
  userClaudeConfigLevel,
} from './paths.mjs';
import { findSubstitutions, parseShell } from './shell.mjs';

/** @typedef {import('./shell.mjs').SimpleCommand} SimpleCommand */

/**
 * Valores conhecidos das variáveis atribuídas no próprio script; `null` = desconhecido.
 * @typedef {Map<string, string[] | null>} Vars
 */

/**
 * @typedef {object} PolicyContext
 * @property {string} cwd diretório onde o comando roda
 * @property {string} projectDir raiz do projeto (CLAUDE_PROJECT_DIR)
 * @property {(cwd: string) => string | null} currentBranch
 * @property {(cwd: string, absPath: string) => { exists: boolean, ref: string | null, rel: string | null }} existsOnDefaultBranch
 * @property {(cwd: string) => Array<[string, string]>} [gitConfigList] configuração de push
 *   persistida no repositório (remote.*.push, push.default, branch.*.merge...)
 * @property {string[]} [altCwds] outros diretórios possíveis depois de `cd`/`pushd`
 * @property {boolean} [cwdUnknown] houve `cd` para destino que não dá para resolver
 * @property {Vars} [vars] variáveis atribuídas no script até este comando
 * @property {string} [headBranch] branch que `git checkout|switch` deixou em HEAD nesta linha
 *   (string com o nome, ou `'unknown'` quando não dá para resolver); sobrepõe `currentBranch`
 * @property {string | null} [headUpstream] branch remoto que `git checkout -b x origin/main`,
 *   `--track` ou `git branch -u` definiu nesta linha como upstream de HEAD (`null` = nenhum,
 *   `'unknown'` = não dá para saber); ausente = vale a configuração persistida
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
/**
 * Caminhos de "arquivo" que são, na verdade, a entrada padrão: `sh /dev/stdin <<< 'cmd'`,
 * `python3 /dev/fd/0`, `bash /proc/self/fd/0`. O script vem do heredoc/here-string/pipe.
 */
const STDIN_SCRIPT_PATH =
  /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/(?:self|thread-self|\d+)\/fd\/0)$/;
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
/** Variáveis que desligam hooks git quando têm valor "falso" (LEFTHOOK=0, HUSKY=0). */
const HOOK_SWITCH_VARS = new Set(['LEFTHOOK', 'HUSKY', 'SIMPLE_GIT_HOOKS']);
/** Variáveis que pulam hooks com qualquer valor. */
const HOOK_SKIP_VARS = new Set([
  'LEFTHOOK_EXCLUDE',
  // LEFTHOOK_BIN troca o binário executado pelo hook; LEFTHOOK_CONFIG aponta para outro
  // arquivo de configuração (um .yml vazio desliga tudo). Qualquer valor desliga os hooks.
  'LEFTHOOK_BIN',
  'LEFTHOOK_CONFIG',
  'HUSKY_SKIP_HOOKS',
  'SKIP',
  'SKIP_SIMPLE_GIT_HOOKS',
]);
/**
 * Leitores que despejam o conteúdo dos arquivos citados: com argumento dinâmico que não dá
 * para resolver (`cat "$1"`), pedem confirmação.
 */
const CONTENT_DUMPERS = new Set([
  'cat',
  'tac',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'nl',
  'od',
  'xxd',
  'hexdump',
  'strings',
  'base64',
  'base32',
  'paste',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'sed',
  'gsed',
  'cp',
  'tar',
]);
/** Leitores de conteúdo para os quais um glob de ponto (`.*`) alcança o .env. */
const CONTENT_READERS = new Set([
  ...CONTENT_DUMPERS,
  'grep',
  'egrep',
  'fgrep',
  'zgrep',
  'rg',
  'ag',
  'ack',
  'sort',
  'uniq',
  'cut',
  'diff',
  'zip',
  'gzip',
  'curl',
]);
/**
 * Programas que não escrevem nos arquivos que citam, ou cuja escrita já é analisada em
 * `writeTargets`/regras próprias. Os demais (desconhecidos) pedem confirmação quando citam
 * a configuração protegida do agente (`.claude/settings*.json`, `.claude/hooks/`).
 */
const KNOWN_FILE_BINS = new Set([
  ...CONTENT_READERS,
  ...SECRET_NAME_ONLY_BINS,
  'll',
  'tree',
  'file',
  'wc',
  'cmp',
  'comm',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'md5sum',
  'shasum',
  'b2sum',
  'cksum',
  'du',
  'jq',
  'yq',
  'tr',
  'column',
  'fold',
  'fmt',
  'node',
  'tsc',
  'shellcheck',
  'cd',
  'pushd',
  'popd',
  'git',
  'find',
  'perl',
  'ruby',
  'python',
  'python3',
  'python2',
  'php',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'vim',
  'vi',
  'nvim',
  'view',
  'ex',
  'ed',
  'tee',
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'truncate',
  'rimraf',
  'mv',
  'install',
  'ln',
  'rsync',
  'chmod',
  'chown',
  'chgrp',
  'chattr',
  'dd',
  'wget',
  'unzip',
  'touch',
  'mkdir',
  'code',
  'open',
  'xdg-open',
]);
/** Chaves de configuração do git cujo valor é um comando executado pelo git. */
const GIT_EXEC_KEYS = [
  /^core\.(?:fsmonitor|sshcommand|editor|pager|askpass|gitproxy|alternaterefscommand)$/,
  /^sequence\.editor$/,
  /^diff\.external$/,
  /^diff\.[^.]+\.(?:command|textconv)$/,
  /^merge\.[^.]+\.driver$/,
  /^filter\.[^.]+\.(?:clean|smudge|process)$/,
  /^credential(?:\..+)?\.helper$/,
  /^gpg(?:\.[^.]+)?\.program$/,
  /^gpg\.ssh\.defaultkeycommand$/,
  /^uploadpack\.packobjectshook$/,
  /^remote\.[^.]+\.(?:uploadpack|receivepack|vcs)$/,
  /^(?:diff|merge)tool\.[^.]+\.cmd$/,
  /^pager\.[^.]+$/,
  /^interactive\.difffilter$/,
  /^(?:web|man)\.browser$/,
  /^(?:browser|man)\.[^.]+\.(?:cmd|path)$/,
  /^sendemail\.(?:smtpserver|tocmd|cccmd)$/,
  /^submodule\.[^.]+\.update$/,
  /^tar\.[^.]+\.command$/,
  // Chave global `protocol.allow` e por-protocolo `protocol.<nome>.allow`: habilitar `ext`
  // ou `always`/`user` libera o transporte ext::, que executa comando arbitrário.
  /^protocol\.(?:[^.]+\.)?allow$/,
  /^alias\./,
];
/** Variáveis de ambiente que o git executa como comando (equivalentes às chaves acima). */
const GIT_EXEC_ENV = new Map([
  ['GIT_SSH_COMMAND', 'core.sshcommand'],
  ['GIT_SSH', 'core.sshcommand'],
  ['GIT_EDITOR', 'core.editor'],
  ['GIT_SEQUENCE_EDITOR', 'sequence.editor'],
  ['GIT_PAGER', 'core.pager'],
  ['GIT_EXTERNAL_DIFF', 'diff.external'],
  ['GIT_ASKPASS', 'core.askpass'],
  ['GIT_PROXY_COMMAND', 'core.gitproxy'],
]);
/** Valores inofensivos para pager/editor (`GIT_PAGER=cat`, `GIT_EDITOR=true`). */
const SAFE_PAGER_EDITOR = /^(?:cat|less(?:\s+-[A-Za-z]+)*|more|true|false|:|)$/;
const MAX_CWDS = 12;
const MAX_EXPANSIONS = 16;

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

/**
 * Expansão indireta `${!nome}`: o valor de `nome` é o NOME da variável que será expandida.
 * Se esse nome é de uma variável sensível conhecida, nega; se é dinâmico/desconhecido (p.ex.
 * `for v in $(compgen -e)`), pede confirmação. `${!pref*}`/`${!pref@}` listam nomes, não
 * valores: ignorados.
 * @param {string} text
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkIndirectExpansion(text, ctx, v) {
  for (const m of String(text).matchAll(/\$\{!([A-Za-z_][A-Za-z0-9_]*)([*@])?\}/g)) {
    if (m[2]) continue;
    const name = m[1] ?? '';
    const vals = ctx.vars?.get(name);
    const resolved = vals && vals.length > 0 && vals.every((x) => !/[$`]/.test(x));
    if (resolved) {
      const leaked = (vals ?? []).find(isSensitiveVarName);
      if (leaked) {
        v.deny(`Expansão indireta \${!${name}} revela a variável sensível ${leaked}; proibido.`);
        return;
      }
    } else {
      v.ask(
        `Expansão indireta \${!${name}} com nome de variável dinâmico/desconhecido pode revelar segredos; confirme.`,
      );
      return;
    }
  }
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
    gitConfigList: gitPushConfig,
  };
}

/**
 * Diretórios onde o comando atual pode estar rodando.
 * @param {PolicyContext} ctx
 * @returns {string[]}
 */
function cwdCandidates(ctx) {
  return [ctx.cwd, ...(ctx.altCwds ?? [])];
}

/**
 * @param {PolicyContext} ctx
 * @param {string[]} cwds o primeiro continua sendo o cwd original
 * @param {boolean} unknown
 * @returns {PolicyContext}
 */
function withCwds(ctx, cwds, unknown) {
  const unique = [...new Set(cwds)];
  const overflow = unique.length > MAX_CWDS;
  return {
    ...ctx,
    cwd: unique[0] ?? ctx.cwd,
    altCwds: unique.slice(1, MAX_CWDS),
    cwdUnknown: Boolean(ctx.cwdUnknown || unknown || overflow),
  };
}

/**
 * Aplica `cd alvo` (ou `-C alvo`) a todos os diretórios candidatos. O original continua na
 * lista: `cd x || true`, subshells e `popd` voltam para ele.
 * @param {PolicyContext} ctx
 * @param {string | undefined} target `undefined` = `cd` sem argumento (HOME)
 * @param {boolean} isDynamic
 * @returns {PolicyContext}
 */
function chdir(ctx, target, isDynamic) {
  const home = process.env.HOME ?? '';
  const current = cwdCandidates(ctx);
  if (target === undefined)
    return home ? withCwds(ctx, [...current, home], false) : withCwds(ctx, current, true);
  let values = [target];
  if (isDynamic || /[$`]/.test(target)) {
    const expanded = expandWord(target, ctx.vars);
    if (expanded.unresolved) return withCwds(ctx, current, true);
    values = expanded.values;
  }
  const cdpath = ctx.vars?.has('CDPATH') ?? false;
  /** @type {string[]} */
  const next = [...current];
  let unknown = false;
  for (const value of values) {
    const resolved = value.replace(/^~(?=\/|$)/, home);
    if (value === '-' || resolved.startsWith('~') || resolved === '' || /[*?[]/.test(resolved)) {
      unknown = true;
      continue;
    }
    if (cdpath && !/^\.{0,2}\//.test(resolved) && !path.isAbsolute(resolved)) unknown = true;
    if (path.isAbsolute(resolved)) next.push(path.resolve(resolved));
    else for (const base of current) next.push(path.resolve(base, resolved));
  }
  return withCwds(ctx, next, unknown);
}

/**
 * Expande `$NOME` e `${NOME}` com os valores conhecidos. Qualquer outra expansão
 * (`$(...)`, crase, `$1`, `${X:-y}`) ou variável desconhecida deixa `unresolved`.
 * @param {string} word
 * @param {Vars | undefined} vars
 * @returns {{ values: string[], unresolved: boolean }}
 */
function expandWord(word, vars) {
  let outs = [''];
  let unresolved = false;
  let i = 0;
  while (i < word.length) {
    const ch = word.charAt(i);
    if (ch === '$') {
      const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(word.slice(i));
      if (m) {
        const known = vars?.get(m[1] ?? m[2] ?? '');
        if (known && known.length > 0) {
          if (known.some((k) => /[$`]/.test(k))) unresolved = true;
          outs = outs.flatMap((o) => known.map((k) => o + k)).slice(0, MAX_EXPANSIONS);
        } else {
          unresolved = true;
          outs = outs.map((o) => o + m[0]);
        }
        i += m[0].length;
        continue;
      }
      unresolved = true;
    }
    if (ch === '`') unresolved = true;
    outs = outs.map((o) => o + ch);
    i++;
  }
  return { values: outs, unresolved };
}

/**
 * Troca expansões (`$X`, `${...}`, `$(...)`, crase) por um marcador, para saber se o nome
 * final do caminho é literal (`"$DIR/saida.txt"`) ou depende de expansão (`"$f"`).
 * @param {string} word
 */
function maskExpansions(word) {
  let out = '';
  let i = 0;
  while (i < word.length) {
    const ch = word.charAt(i);
    if (ch === '$' && (word.charAt(i + 1) === '(' || word.charAt(i + 1) === '{')) {
      const open = word.charAt(i + 1);
      const end = findClose(word, i + 2, open, open === '(' ? ')' : '}');
      out += '\u0000';
      i = end === -1 ? word.length : end + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(word.slice(i));
      out += '\u0000';
      i += m ? m[0].length : 1;
      continue;
    }
    if (ch === '`') {
      const end = word.indexOf('`', i + 1);
      out += '\u0000';
      i = end === -1 ? word.length : end + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * @param {string} text
 * @param {number} start
 * @param {string} open
 * @param {string} close
 */
function findClose(text, start, open, close) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

/**
 * @param {PolicyContext} ctx
 * @param {Array<[string, string[] | null]>} entries
 * @returns {PolicyContext}
 */
function withVars(ctx, entries) {
  const vars = new Map(ctx.vars ?? []);
  for (const [name, values] of entries) vars.set(name, values);
  return { ...ctx, vars };
}

/**
 * Valores possíveis de uma atribuição `NOME=valor` (ou `NOME+=valor`).
 * @param {string} assignment
 * @param {boolean} isDynamic
 * @param {Vars | undefined} vars
 * @returns {[string, string[] | null]}
 */
function assignmentValues(assignment, isDynamic, vars) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=([\s\S]*)$/.exec(assignment);
  const name = m?.[1] ?? '';
  const raw = m?.[4] ?? '';
  if (m?.[2]) return [name, null];
  let values = [raw];
  if (isDynamic || /[$`]/.test(raw)) values = expandWord(raw, vars).values;
  if (m?.[3] === '+') {
    const before = vars?.get(name);
    if (!before) return [name, null];
    values = before.flatMap((b) => values.map((x) => b + x)).slice(0, MAX_EXPANSIONS);
  }
  return [name, values];
}

/**
 * Atualiza o estado do script depois de um comando: variáveis atribuídas e diretório.
 * @param {SimpleCommand} cmd
 * @param {PolicyContext} ctx
 * @returns {PolicyContext}
 */
function trackState(cmd, ctx) {
  const words = cmd.words;
  const dyn = cmd.dynamic;
  if ((words[0] === 'for' || words[0] === 'select') && /^[A-Za-z_]\w*$/.test(words[1] ?? '')) {
    const name = words[1] ?? '';
    if (words[2] !== 'in') return withVars(ctx, [[name, null]]);
    /** @type {string[]} */
    const values = [];
    for (let j = 3; j < words.length; j++) {
      const w = words[j] ?? '';
      if (dyn[j]) values.push(...expandWord(w, ctx.vars).values);
      else values.push(w);
    }
    return withVars(ctx, [[name, values.slice(0, MAX_EXPANSIONS)]]);
  }
  let k = 0;
  while (k < words.length && RESERVED_LEADING.has(words[k] ?? '') && !dyn[k]) k++;
  /** @type {Array<[string, string[] | null]>} */
  const assigned = [];
  while (k < words.length && isAssignment(words[k] ?? '')) {
    assigned.push(assignmentValues(words[k] ?? '', dyn[k] ?? false, ctx.vars));
    k++;
  }
  if (k >= words.length) return assigned.length > 0 ? withVars(ctx, assigned) : ctx;
  const bin = path.posix.basename(words[k] ?? '');
  const args = words.slice(k + 1);
  const argsDyn = dyn.slice(k + 1);
  switch (bin) {
    case 'export':
    case 'declare':
    case 'typeset':
    case 'local':
    case 'readonly': {
      /** @type {Array<[string, string[] | null]>} */
      const entries = [];
      args.forEach((a, j) => {
        if (isAssignment(a)) entries.push(assignmentValues(a, argsDyn[j] ?? false, ctx.vars));
      });
      return entries.length > 0 ? withVars(ctx, entries) : ctx;
    }
    case 'unset': {
      const vars = new Map(ctx.vars ?? []);
      for (const a of args) if (!a.startsWith('-')) vars.delete(a);
      return { ...ctx, vars };
    }
    case 'read':
    case 'mapfile':
    case 'readarray': {
      const names = readTargetNames(bin, args);
      const here = cmd.hereStrings[0];
      const value = names.length === 1 && here !== undefined ? [here] : null;
      return withVars(
        ctx,
        names.map((n) => [n, value]),
      );
    }
    case 'printf': {
      const at = args.indexOf('-v');
      const name = at >= 0 ? args[at + 1] : undefined;
      if (!name) return ctx;
      const rest = args.slice(at + 2);
      const value = rest.some((_a, j) => argsDyn[at + 2 + j]) ? null : [rest.join(' ')];
      return withVars(ctx, [[name, value]]);
    }
    case 'cd':
    case 'pushd': {
      const i = args.findIndex((a) => !/^-[LPe@]+$/.test(a));
      const target = i >= 0 ? args[i] : undefined;
      if (bin === 'pushd' && target !== undefined && /^[+-]\d+$/.test(target)) {
        return withCwds(ctx, cwdCandidates(ctx), true);
      }
      return chdir(ctx, target, i >= 0 ? (argsDyn[i] ?? false) : false);
    }
    case 'git': {
      // `git checkout|switch` troca o HEAD e `git branch -u` muda o upstream dele antes de um
      // `git push` na mesma linha.
      const change = trackGitHead(args);
      if (change === null) return ctx;
      if (change.branch !== undefined) {
        return {
          ...ctx,
          headBranch: change.branch,
          headUpstream: change.renamed ? ctx.headUpstream : change.upstream,
        };
      }
      // Só o upstream mudou: vale quando o branch alvo é o HEAD; alvo dinâmico pode ser o HEAD,
      // e aí o upstream fica desconhecido (fail-closed).
      if (change.upstreamOf === 'unknown') return { ...ctx, headUpstream: 'unknown' };
      const head = ctx.headBranch ?? ctx.currentBranch(ctx.cwd);
      const other =
        change.upstreamOf !== undefined &&
        head !== null &&
        head !== 'unknown' &&
        change.upstreamOf !== head;
      return other ? ctx : { ...ctx, headUpstream: change.upstream };
    }
    default:
      return ctx;
  }
}

/**
 * O que um `git ...` muda no HEAD, para um `git push` na mesma linha.
 * - `branch`: branch que fica em HEAD (`'unknown'` quando não dá para resolver: `-`,
 *   `--detach`, nome dinâmico); ausente quando o comando não troca de branch.
 * - `upstream`: branch remoto que o comando define como upstream (`main` em
 *   `git checkout -b x origin/main`), `null` quando não define nenhum, `'unknown'` quando não dá
 *   para saber (`--track=inherit`, `origin/HEAD`, ponto de partida dinâmico ou sem a forma
 *   `<remoto>/<branch>`); ausente quando o comando não
 *   mexe no upstream (troca para branch existente: vale a configuração persistida).
 * - `upstreamOf`: branch cujo upstream `git branch -u <up> <branch>` mudou (ausente = HEAD,
 *   inclusive com alvo `HEAD` ou `@`; `'unknown'` quando o alvo é dinâmico).
 * - `renamed`: `git branch -m` renomeia e o upstream segue a branch.
 * @typedef {object} GitHeadChange
 * @property {string} [branch]
 * @property {string | null} [upstream]
 * @property {string} [upstreamOf]
 * @property {boolean} [renamed]
 */

/** Opções globais do git com valor no argumento seguinte (`git -C dir checkout ...`). */
const GIT_GLOBAL_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--attr-source',
  '--list-cmds',
]);

/**
 * Branch remoto de uma ref de rastreamento: `origin/main`, `remotes/origin/main` e
 * `refs/remotes/origin/main` dão `main`. `null` quando a ref é claramente local (`HEAD`, `@`,
 * `HEAD~2`, hash, `refs/heads/x`, `refs/tags/x`). `'unknown'` quando não tem a forma
 * `<remoto>/<branch>` clara: `origin/HEAD` aponta para a branch padrão do remoto, e um nome sem
 * barra pode ser um remoto (`origin` resolve para `origin/HEAD`) ou uma branch local (fail-closed).
 * @param {string} ref
 * @returns {string | null}
 */
function remoteBranchOf(ref) {
  if (/^(?:HEAD|@)(?:[~^]\d*)*$/.test(ref) || /^[0-9a-f]{7,64}$/i.test(ref)) return null;
  if (/^refs\/(?:heads|tags)\//.test(ref)) return null;
  const r = ref.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '');
  if (r.startsWith('refs/')) return null;
  const slash = r.indexOf('/');
  if (slash <= 0 || slash === r.length - 1) return 'unknown';
  const branch = r.slice(slash + 1);
  return branch === 'HEAD' ? 'unknown' : branch;
}

/**
 * Ref ou nome que não dá para resolver sem executar (`-`, `@{-1}`, variável, curinga).
 * @param {string} ref
 */
function isUnresolvedRef(ref) {
  return ref === '-' || /^@\{-?\d*\}?$/.test(ref) || /[$`*?[]/.test(ref);
}

/**
 * Lê `git checkout|switch` como o parse-options do git (2.43): letras agrupadas (`-qb x`,
 * `-bx`, `-qcmain`), valor anexado opcional do `-t` (`-tdirect`), prefixo único de opção longa
 * (`--tr`, `--cre=x`); entre `--track` e `--no-track`, vale o último. No `checkout`, `--`
 * separa caminhos (`git checkout main -- arquivo` não troca de branch); no `switch`, só encerra
 * as opções (`git switch -- main` troca para main).
 *
 * Upstream da branch criada (`-b`/`-c`/`--orphan`): com `--track` ou sem opção de rastreamento
 * (branch.autoSetupMerge=true, o padrão), ponto de partida remoto vira o upstream; `--no-track`
 * não define nenhum; `--track=inherit` copia o do ponto de partida (desconhecido). Sem
 * `-b`/`-c`, `--track origin/main` cria a branch local `main` (conferido no git 2.43).
 * @param {'checkout' | 'switch'} sub
 * @param {string[]} rest argumentos depois do subcomando
 * @returns {GitHeadChange | null}
 */
function trackCheckoutSwitch(sub, rest) {
  const createShort = sub === 'switch' ? 'cC' : 'bB';
  const createLong = sub === 'switch' ? ['--create', '--force-create', '--orphan'] : ['--orphan'];
  /** @type {string | undefined} */
  let created;
  let detach = false;
  /** @type {'direct' | 'inherit' | false | undefined} `undefined` = padrão do git */
  let track;
  /** @type {string[]} */
  const positionals = [];
  let endOfOptions = false;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? '';
    if (endOfOptions || !a.startsWith('-') || a === '-') {
      positionals.push(a);
      continue;
    }
    if (a === '--') {
      if (sub === 'checkout') {
        // O resto são caminhos: sem -b/--track, só restaura arquivos.
        if (created === undefined && !track) return null;
        break;
      }
      endOfOptions = true;
      continue;
    }
    if (a.startsWith('--')) {
      const resolved = resolveGitLongOption(sub, a);
      if (resolved === null || 'ambiguous' in resolved) continue; // o git recusa e não roda
      if (createLong.includes(resolved.name)) {
        if (resolved.value !== null) created = resolved.value;
        else {
          k++;
          created = rest[k] ?? 'unknown';
        }
      } else if (resolved.name === '--track') {
        track = resolved.value === 'inherit' ? 'inherit' : 'direct';
      } else if (resolved.name === '--no-track') {
        track = false;
      } else if (resolved.name === '--detach') {
        detach = true;
      } else if (resolved.value === null && gitOptionTakesValue(sub, resolved.name)) {
        k++;
      }
      continue;
    }
    for (let c = 1; c < a.length; c++) {
      const ch = a.charAt(c);
      const attached = a.slice(c + 1);
      if (createShort.includes(ch)) {
        if (attached !== '') created = attached;
        else {
          k++;
          created = rest[k] ?? 'unknown';
        }
        break;
      }
      if (ch === 't') {
        // `-t` aceita valor só anexado (`-tdirect`, `-tinherit`); o resto do grupo é dele.
        track = attached === 'inherit' ? 'inherit' : 'direct';
        break;
      }
      if (ch === 'd') detach = true;
    }
  }
  if (detach) return { branch: 'unknown' };
  const start = positionals[0];
  if (created !== undefined) {
    /** @type {string | null} */
    let upstream = null;
    if (track === 'inherit') upstream = 'unknown';
    else if (track !== false && start !== undefined) {
      upstream = isUnresolvedRef(start) ? 'unknown' : remoteBranchOf(start);
    }
    return { branch: isUnresolvedRef(created) ? 'unknown' : created, upstream };
  }
  if (track) {
    // Sem nome, a branch local leva o nome do branch remoto (`-t origin/main` cria `main`).
    const derived = start === undefined || isUnresolvedRef(start) ? null : remoteBranchOf(start);
    if (derived === null) return { branch: 'unknown', upstream: 'unknown' };
    return { branch: derived, upstream: track === 'inherit' ? 'unknown' : derived };
  }
  if (start === undefined) return null;
  return { branch: isUnresolvedRef(start) ? 'unknown' : start };
}

/**
 * `git branch -m/-M` (renomeia) e `git branch -u/--set-upstream-to/--unset-upstream` (upstream
 * de HEAD ou do branch indicado), com letras agrupadas e valor anexado (`-uorigin/main`).
 * @param {string[]} rest argumentos depois de `branch`
 * @returns {GitHeadChange | null}
 */
function trackBranch(rest) {
  if (rest.includes('-m') || rest.includes('-M')) {
    const names = rest.filter((a) => !a.startsWith('-'));
    return { branch: names.at(-1) ?? 'unknown', renamed: true };
  }
  /** @type {string | null | undefined} */
  let upstream;
  /** @type {string[]} */
  const names = [];
  /** @param {string} value */
  const upstreamOf = (value) => (isUnresolvedRef(value) ? 'unknown' : remoteBranchOf(value));
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? '';
    if (a === '--') {
      names.push(...rest.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const resolved = resolveGitLongOption('branch', a);
      if (resolved === null || 'ambiguous' in resolved) continue;
      if (resolved.name === '--set-upstream-to') {
        let value = resolved.value;
        if (value === null) {
          k++;
          value = rest[k] ?? '';
        }
        upstream = upstreamOf(value);
      } else if (resolved.name === '--unset-upstream') {
        upstream = null;
      } else if (resolved.value === null && gitOptionTakesValue('branch', resolved.name)) {
        k++;
      }
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      const at = a.indexOf('u');
      if (at > 0) {
        let value = a.slice(at + 1);
        if (value === '') {
          k++;
          value = rest[k] ?? '';
        }
        upstream = upstreamOf(value);
      }
      continue;
    }
    names.push(a);
  }
  if (upstream === undefined) return null;
  const target = names[0];
  // `HEAD` e `@` são a branch atual, como sem alvo.
  if (target === undefined || target === 'HEAD' || target === '@') return { upstream };
  return { upstream, upstreamOf: isUnresolvedRef(target) ? 'unknown' : target };
}

/**
 * O que `git ...` muda no HEAD antes de um `git push` na mesma linha (ver GitHeadChange), ou
 * `null` quando não muda nada (ex.: `git checkout -- arquivo`).
 * @param {string[]} words argumentos depois de `git`
 * @returns {GitHeadChange | null}
 */
function trackGitHead(words) {
  let i = 0;
  while (i < words.length) {
    const a = words[i] ?? '';
    if (GIT_GLOBAL_VALUE_OPTIONS.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    break;
  }
  const sub = words[i];
  const rest = words.slice(i + 1);
  if (sub === 'checkout' || sub === 'switch') return trackCheckoutSwitch(sub, rest);
  if (sub === 'symbolic-ref' && rest[0] === 'HEAD' && rest[1] !== undefined) {
    return { branch: /[$`]/.test(rest[1]) ? 'unknown' : normalizeBranchRef(rest[1]) };
  }
  if (sub === 'branch') return trackBranch(rest);
  return null;
}
/**
 * Nomes de variáveis que `read`/`mapfile` vão preencher.
 * @param {string} bin
 * @param {string[]} args
 * @returns {string[]}
 */
function readTargetNames(bin, args) {
  const valueOpts =
    bin === 'read'
      ? new Set(['-a', '-d', '-i', '-n', '-N', '-p', '-t', '-u'])
      : new Set(['-d', '-n', '-O', '-s', '-u', '-C', '-c']);
  /** @type {string[]} */
  const names = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j] ?? '';
    if (valueOpts.has(a)) {
      if (a === '-a' && args[j + 1]) names.push(args[j + 1] ?? '');
      j++;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (/^[A-Za-z_]\w*$/.test(a)) names.push(a);
  }
  if (names.length === 0) names.push(bin === 'read' ? 'REPLY' : 'MAPFILE');
  return names;
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
  let state = ctx;
  for (const cmd of parsed.commands) {
    for (const sub of cmd.substitutions) analyzeScript(sub, state, depth + 1, v);
    for (const sub of cmd.processSubstitutions) analyzeScript(sub, state, depth + 1, v);
    for (const heredoc of cmd.heredocs) {
      if (!heredoc.expand) continue;
      const found = findSubstitutions(heredoc.body);
      for (const sub of found.subs) analyzeScript(sub, state, depth + 1, v);
      for (const error of found.errors) v.ask(`Heredoc com expansão não analisável (${error}).`);
    }
    analyzeSimpleCommand(cmd, parsed.commands, state, depth, v);
    state = trackState(cmd, state);
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
  /** @type {Array<[string, string[] | null]>} */
  const prefix = [];
  while (words.length > 0 && isAssignment(words[0] ?? '')) {
    checkAssignment(words[0] ?? '', dynamic[0] ?? false, ctx, depth, v);
    prefix.push(assignmentValues(words[0] ?? '', dynamic[0] ?? false, ctx.vars));
    words.shift();
    dynamic.shift();
  }
  if (words.length === 0) return;
  // Atribuições prefixadas valem para o ambiente do comando (GIT_CONFIG_*, HOME...).
  analyzeArgv(words, dynamic, cmd, all, prefix.length > 0 ? withVars(ctx, prefix) : ctx, depth, v);
}

/**
 * Regras para `NOME=valor` (prefixo de comando, `export`, `declare`, `env`...).
 * @param {string} assignment
 * @param {boolean} isDynamic
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkAssignment(assignment, isDynamic, ctx, depth, v) {
  const eq = assignment.indexOf('=');
  const name = assignment.slice(0, eq).replace(/\+$/, '');
  const value = assignment.slice(eq + 1);
  const dynamicValue = isDynamic || /[$`]/.test(value);
  if (
    HOOK_SKIP_VARS.has(name) ||
    (HOOK_SWITCH_VARS.has(name) && /^(?:0|false|off|no)?$/i.test(value))
  ) {
    v.deny('Desativar os hooks git (LEFTHOOK=0, HUSKY=0...) é proibido: corrija a causa da falha.');
  } else if (HOOK_SWITCH_VARS.has(name) && dynamicValue) {
    v.ask(`${name} com valor dinâmico pode desligar os hooks git; confirme.`);
  }
  if (/^GIT_CONFIG_(?:PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(name)) {
    if (/hookspath|include(?:if\.[^=\s'"]*)?\.path/i.test(value)) {
      v.deny(
        'Alterar core.hooksPath ou include.path por variável de ambiente desliga os hooks; proibido.',
      );
    }
  }
  if (/^GIT_CONFIG(?:_GLOBAL|_SYSTEM)?$/.test(name) && value !== '/dev/null') {
    v.deny(
      `${name} troca o arquivo de configuração do git (pode trazer core.hooksPath e desligar os hooks); proibido. Só ${name}=/dev/null é aceito.`,
    );
  }
  if (name === 'NODE_OPTIONS') {
    // `--import=data:...`/`--require` em NODE_OPTIONS roda código em todo processo node.
    const words = value.split(/\s+/).map((w) => w.replace(/^(['"])(.*)\1$/, '$2'));
    const parsed = parseInterpreterArgs('node', words.filter(Boolean));
    for (const inline of parsed.inline) checkInlineCode(inline.code, v, ctx, 'node', depth);
    for (const opt of parsed.unknown) {
      v.ask(`NODE_OPTIONS com ${opt}: o guard-bash não sabe o que isso executa; confirme.`);
    }
  }
  const execKey = GIT_EXEC_ENV.get(name);
  if (execKey) {
    checkGitExecValue(execKey, name, dynamicValue ? null : value, ctx, depth, v);
  } else if (name === 'GIT_EXEC_PATH') {
    v.ask('GIT_EXEC_PATH troca os programas que o git executa; confirme.');
  } else if (
    name === 'GIT_ALLOW_PROTOCOL' &&
    (dynamicValue || /(?:^|:)\s*ext\s*(?::|$)/i.test(value))
  ) {
    v.ask(
      'GIT_ALLOW_PROTOCOL habilita o transporte ext::, que executa comando arbitrário; confirme.',
    );
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
  let current = ctx;
  for (let guard = 0; guard < 16 && argv.length > 0; guard++) {
    const first = argv[0] ?? '';
    if (dynamic[0] || /[$`]/.test(first)) {
      v.ask(`Nome de comando dinâmico (${first}); confirme o que será executado.`);
      return;
    }
    // Segredo como programa (`./.env`, `env ./.env`, `xargs .env`): o shell interpreta o
    // arquivo, e as mensagens de erro e as atribuições expõem o conteúdo.
    const secret = classifySecretPath(first);
    if (secret) {
      v.deny(`Executar ${secret.reason} como comando expõe o conteúdo; bloqueado.`);
      return;
    }
    // `python3.13`, `pypy3`, `php8.3`, `nodejs` seguem as regras do interpretador.
    const bin = canonicalInterpreter(path.posix.basename(first));
    const args = argv.slice(1);
    const argsDynamic = dynamic.slice(1);
    const next = unwrap(bin, args, argsDynamic, cmd, all, current, depth, v);
    if (next === 'stop') return;
    if (next) {
      argv = next.argv;
      dynamic = next.dynamic;
      if (next.ctx) current = next.ctx;
      continue;
    }
    checkCommand(bin, args, argsDynamic, cmd, all, current, depth, v);
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
 * Pula opções no estilo getopt, inclusive agrupadas (`-fe`, `-c3`, `-iS`). `flags` são letras
 * sem valor; `values` letras cujo valor é o resto do agrupamento ou o próximo argumento.
 * Opções longas: `--x` e `--x=v` consomem só a si (um argumento); `--x` em `longValues`
 * consome também o próximo. Para em `--` (consumindo-o) ou no primeiro posicional. Devolve o
 * índice do primeiro posicional e o conjunto de letras curtas vistas (para detectar `-p`).
 * @param {string[]} args
 * @param {{ flags?: string, values?: string, longValues?: string[] }} [spec]
 * @returns {{ index: number, seen: Set<string>, longSeen: Set<string> }}
 */
function skipGetopt(args, spec = {}) {
  const values = spec.values ?? '';
  const longValues = spec.longValues ?? [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Set<string>} */
  const longSeen = new Set();
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '--') return { index: i + 1, seen, longSeen };
    if (!a.startsWith('-') || a === '-') return { index: i, seen, longSeen };
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      longSeen.add(name);
      i += eq < 0 && longValues.includes(name) ? 2 : 1;
      continue;
    }
    let consumedNext = false;
    for (let j = 1; j < a.length; j++) {
      const ch = a.charAt(j);
      seen.add(ch);
      if (values.includes(ch)) {
        if (j === a.length - 1) consumedNext = true;
        break;
      }
    }
    i += consumedNext ? 2 : 1;
  }
  return { index: i, seen, longSeen };
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
 * @returns {{ argv: string[], dynamic: boolean[], ctx?: PolicyContext } | 'stop' | null}
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
      // `-w`/`--wait` é flag (não leva valor); separado de caffeinate, cujo `-w` leva valor.
      return slice(args, dynamic, skipGetopt(args, { values: '' }).index);
    case 'caffeinate':
      return slice(args, dynamic, skipGetopt(args, { values: 'tw' }).index);
    case 'nice':
      return slice(args, dynamic, skipGetopt(args, { values: 'n' }).index);
    case 'ionice': {
      // `-p`/`-P`/`-u` operam sobre processo/usuário existente (sem comando); só então `stop`.
      // Procurar só nas opções de ionice, antes do primeiro posicional (o `-p` no fim de
      // `ionice sh -c ... -p` é argumento do comando embrulhado).
      const { index, seen } = skipGetopt(args, { values: 'cnpPu' });
      if (seen.has('p') || seen.has('P') || seen.has('u')) return 'stop';
      return slice(args, dynamic, index);
    }
    case 'taskset': {
      // `taskset [opções] máscara comando` ou `taskset -p [opções] pid` (processo existente).
      const { index, seen, longSeen } = skipGetopt(args, {
        values: 'c',
        longValues: ['--cpu-list'],
      });
      if (seen.has('p') || longSeen.has('--pid')) return 'stop';
      // Com `-c lista`/`--cpu-list` a máscara é o valor da opção; senão é um posicional.
      const list = seen.has('c') || longSeen.has('--cpu-list');
      return slice(args, dynamic, list ? index : index + 1);
    }
    case 'chrt': {
      // `chrt [opções] prioridade comando` ou `chrt -p [prio] pid` (processo existente).
      const { index, seen, longSeen } = skipGetopt(args);
      if (seen.has('p') || longSeen.has('--pid')) return 'stop';
      return slice(args, dynamic, index + 1);
    }
    case 'numactl': {
      const { index } = skipGetopt(args, {
        values: 'CNmpi',
        longValues: ['--physcpubind', '--cpunodebind', '--membind', '--preferred', '--interleave'],
      });
      if (index >= args.length) return 'stop';
      return slice(args, dynamic, index);
    }
    case 'unshare':
    case 'nsenter':
    case 'prlimit':
    case 'cpulimit':
    case 'runuser':
    case 'fakeroot':
    case 'firejail':
    case 'bwrap':
      return unwrapExecSandbox(bin, args, dynamic, cmd, all, ctx, depth, v);
    case 'stdbuf':
      return slice(args, dynamic, skipGetopt(args, { values: 'ioe' }).index);
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
      return unwrapXargs(args, dynamic, cmd, all, ctx, v);
    case 'busybox':
      return slice(args, dynamic, 0);
    case 'script':
      return unwrapScript(args, dynamic, ctx, depth, v);
    case 'strace':
    case 'ltrace': {
      // `-fe trace=none`, `-fo arquivo`: as letras de valor (o,e,p,s,u,E,O,a,b,I,S,X,P)
      // consomem o resto do agrupamento ou o argumento seguinte; sem isso, o alvo da trace
      // virava "comando".
      const values = 'oepsuEOabISXP';
      const { index } = skipGetopt(args, { values, longValues: ['--output'] });
      for (let k = 0; k < index && k < args.length; k++) {
        const a = args[k] ?? '';
        if (a === '-o' && args[k + 1] !== undefined)
          checkWriteTarget(args[k + 1] ?? '', ctx, v, bin);
        else if (a.startsWith('--output='))
          checkWriteTarget(a.slice('--output='.length), ctx, v, bin);
        else if (a === '--output' && args[k + 1] !== undefined) {
          checkWriteTarget(args[k + 1] ?? '', ctx, v, bin);
        } else if (!a.startsWith('--') && a.startsWith('-')) {
          const oi = a.indexOf('o');
          // `o` só é o arquivo de saída se nenhuma letra de valor veio antes no agrupamento.
          if (oi > 0 && ![...a.slice(1, oi)].some((c) => values.includes(c))) {
            const rest = a.slice(oi + 1);
            if (rest !== '') checkWriteTarget(rest, ctx, v, bin);
            else if (args[k + 1] !== undefined) checkWriteTarget(args[k + 1] ?? '', ctx, v, bin);
          }
        }
      }
      return slice(args, dynamic, index);
    }
    case 'expect':
      if (args.some((a) => a === '-c' || /^-[a-zA-Z]*c$/.test(a))) {
        v.ask('expect -c executa código Tcl (e comandos) que o guard-bash não analisa; confirme.');
      }
      return null;
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
      checkSource(args, dynamic, cmd, all, ctx, depth, v);
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
    case 'corepack': {
      // `corepack pnpm add x` roda o gerenciador: reanalisa como `pnpm add x`. O resto
      // (enable/prepare/use...) fica para checkCommand.
      const head = (args[0] ?? '').replace(/@[^/]*$/, '');
      const pm = head === 'yarnpkg' ? 'yarn' : head;
      if (['pnpm', 'pnpx', 'npm', 'npx', 'yarn', 'bunx', 'bun'].includes(pm)) {
        return {
          argv: [pm, ...args.slice(1)],
          dynamic: [dynamic[0] ?? false, ...dynamic.slice(1)],
        };
      }
      return null;
    }
    default:
      if (SHELL_BINS.has(bin) || bin === 'pwsh' || bin === 'powershell') {
        checkShell(bin, args, dynamic, cmd, all, ctx, depth, v);
        return 'stop';
      }
      return unknownWrapperFallback(bin, args, dynamic, cmd, all, ctx, depth, v);
  }
}

/** Comandos de introspecção que citam outro comando sem executá-lo (não são wrappers). */
const DESCRIBE_BINS = new Set([
  'which',
  'type',
  'whereis',
  'whatis',
  'man',
  'help',
  'whence',
  'hash',
  'compgen',
  'apropos',
  'info',
]);
/** Comandos perigosos que, como primeiro posicional de um binário desconhecido, pedem confirmação. */
const WRAPPED_DANGER_BINS = new Set([
  ...SHELL_BINS,
  ...STDIN_INTERPRETERS,
  'git',
  'rm',
  'pnpm',
  'npm',
  'npx',
  'pnpx',
  'yarn',
  'bunx',
  'corepack',
]);

/**
 * Sandbox/isoladores pouco usados (unshare, nsenter, firejail, bwrap, fakeroot, cpulimit,
 * prlimit, runuser): o agente não tem motivo legítimo para eles. Pede confirmação e ainda
 * tenta analisar o comando interno, para que um `deny` interno (push --force, cat .env) valha.
 * @param {string} bin
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 * @returns {'stop'}
 */
function unwrapExecSandbox(bin, args, dynamic, cmd, all, ctx, depth, v) {
  // `-c CMD`/`--command CMD`/`--session-command CMD` (runuser) é código de shell.
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? '';
    if (
      (a === '-c' || a === '--command' || a === '--session-command') &&
      args[k + 1] !== undefined
    ) {
      analyzeScript(args[k + 1] ?? '', ctx, depth + 1, v);
    } else if (/^--(?:command|session-command)=/.test(a)) {
      analyzeScript(a.slice(a.indexOf('=') + 1), ctx, depth + 1, v);
    }
  }
  // Pula as opções (melhor esforço) e analisa o que sobra como comando interno.
  const valueLetters =
    { prlimit: '', cpulimit: 'lpe', runuser: 'ugGsc', nsenter: 'tSG' }[bin] ?? '';
  const { index } = skipGetopt(args, { values: valueLetters });
  if (index < args.length && !args[index]?.startsWith('-')) {
    analyzeArgv(args.slice(index), dynamic.slice(index), cmd, all, ctx, depth + 1, v);
  }
  v.ask(`${bin} isola ou altera o processo; confirme o comando que ele executa.`);
  return 'stop';
}

/**
 * Binário desconhecido cujo primeiro posicional (depois de opções curtas/longas iniciais) é
 * um comando perigoso (git, rm, shell, interpretador, pnpm...): provável wrapper de execução.
 * Pede confirmação e analisa o comando interno, para que um `deny` interno ainda valha.
 * @param {string} bin
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 * @returns {null | 'stop'}
 */
function unknownWrapperFallback(bin, args, dynamic, cmd, all, ctx, depth, v) {
  // Interpretadores e comandos conhecidos têm tratamento próprio em checkCommand; só binários
  // realmente desconhecidos (não introspecção) entram aqui.
  if (DESCRIBE_BINS.has(bin) || KNOWN_FILE_BINS.has(bin) || interpreterFamily(bin) !== null) {
    return null;
  }
  const first = args.findIndex((a) => !a.startsWith('-'));
  if (first < 0) return null;
  const inner = canonicalInterpreter(path.posix.basename(args[first] ?? ''));
  if (!WRAPPED_DANGER_BINS.has(inner)) return null;
  analyzeArgv(args.slice(first), dynamic.slice(first), cmd, all, ctx, depth + 1, v);
  v.ask(`${bin} parece um wrapper desconhecido executando ${inner}; confirme o que roda.`);
  return 'stop';
}

/**
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 * @returns {{ argv: string[], dynamic: boolean[], ctx: PolicyContext } | 'stop'}
 */
function unwrapEnv(args, dynamic, ctx, depth, v) {
  let i = 0;
  let next = ctx;
  /** @type {Array<[string, string[] | null]>} */
  const assigned = [];
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-S' || a === '--split-string') {
      analyzeScript(args.slice(i + 1).join(' '), withVars(next, assigned), depth + 1, v);
      return 'stop';
    }
    if (a.startsWith('--split-string=')) {
      analyzeScript(
        [a.slice('--split-string='.length), ...args.slice(i + 1)].join(' '),
        withVars(next, assigned),
        depth + 1,
        v,
      );
      return 'stop';
    }
    if (a === '-C' || a === '--chdir') {
      next = chdir(next, args[i + 1] ?? '', dynamic[i + 1] ?? false);
      i += 2;
      continue;
    }
    if (a.startsWith('--chdir=')) {
      next = chdir(next, a.slice('--chdir='.length), dynamic[i] ?? false);
      i++;
      continue;
    }
    if (a === '-u' || a === '--unset') {
      i += 2;
      continue;
    }
    if (a.startsWith('--')) {
      i++;
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      // Agrupamento curto: `i`/`0`/`v` são flags; `u` leva valor; `C` muda de diretório;
      // `S` (split-string) consome o resto do agrupamento ou o próximo argumento e o que vem
      // depois é o script — `env -iS 'cmd'` não pode esconder o comando.
      let consumedNext = false;
      for (let j = 1; j < a.length; j++) {
        const ch = a.charAt(j);
        const rest = a.slice(j + 1);
        if (ch === 'S') {
          const str = rest !== '' ? rest : (args[i + 1] ?? '');
          const after = rest !== '' ? args.slice(i + 1) : args.slice(i + 2);
          analyzeScript([str, ...after].join(' '), withVars(next, assigned), depth + 1, v);
          return 'stop';
        }
        if (ch === 'u') {
          if (rest === '') consumedNext = true;
          break;
        }
        if (ch === 'C') {
          const dir = rest !== '' ? rest : (args[i + 1] ?? '');
          next = chdir(next, dir, (rest !== '' ? dynamic[i] : dynamic[i + 1]) ?? false);
          if (rest === '') consumedNext = true;
          break;
        }
        // i, 0, v e desconhecidas: segue.
      }
      i += consumedNext ? 2 : 1;
      continue;
    }
    if (isAssignment(a)) {
      checkAssignment(a, dynamic[i] ?? false, next, depth, v);
      assigned.push(assignmentValues(a, dynamic[i] ?? false, next.vars));
      i++;
      continue;
    }
    break;
  }
  if (i >= args.length) {
    v.deny('Despejar as variáveis de ambiente (env) expõe segredos.');
    return 'stop';
  }
  return { ...slice(args, dynamic, i), ctx: withVars(next, assigned) };
}

/**
 * `script [-q] -c CMD [arquivo]`: roda CMD num pseudo-terminal.
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 * @returns {'stop'}
 */
function unwrapScript(args, dynamic, ctx, depth, v) {
  /** @type {string[]} */
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    let command = null;
    let commandDynamic = false;
    if (a === '-c' || a === '--command' || (/^-[A-Za-z]*c$/.test(a) && !a.startsWith('--'))) {
      command = args[i + 1] ?? '';
      commandDynamic = dynamic[i + 1] ?? false;
      i++;
    } else if (a.startsWith('--command=')) {
      command = a.slice('--command='.length);
      commandDynamic = dynamic[i] ?? false;
    } else if (/^-[A-Za-z]*c./.test(a) && !a.startsWith('--')) {
      command = a.slice(a.indexOf('c') + 1);
      commandDynamic = dynamic[i] ?? false;
    } else if (/^-[A-Za-z]*[ITBEO]$/.test(a) || /^--(?:log-|timing$|echo$)/.test(a)) {
      i++;
      continue;
    } else if (!a.startsWith('-')) {
      positionals.push(a);
      continue;
    }
    if (command !== null) {
      if (commandDynamic) v.ask('script -c com comando dinâmico; confirme o que será executado.');
      analyzeScript(command, ctx, depth + 1, v);
    }
  }
  for (const file of positionals) checkWriteTarget(file, ctx, v, 'script');
  return 'stop';
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
 * Opções longas do xargs (findutils 4.9): `required` leva valor (`--arg-file=X` ou no
 * argumento seguinte); `optional` só com `=`; `none` não leva.
 * @type {Record<string, 'required' | 'optional' | 'none'>}
 */
const XARGS_LONG_OPTIONS = {
  null: 'none',
  'arg-file': 'required',
  delimiter: 'required',
  eof: 'optional',
  replace: 'optional',
  'max-lines': 'optional',
  'max-args': 'required',
  'open-tty': 'none',
  interactive: 'none',
  'no-run-if-empty': 'none',
  'max-chars': 'required',
  verbose: 'none',
  'show-limits': 'none',
  exit: 'none',
  'max-procs': 'required',
  'process-slot-var': 'required',
  version: 'none',
  help: 'none',
};

/**
 * Lê as opções do xargs como o getopt_long dele (findutils 4.9,
 * "+0a:E:e::i::I:l::L:n:oprs:txP:d:"): letras agrupadas (`-ra`, `-0ra`), valor anexado ou no
 * argumento seguinte para a, d, E, I, L, n, P, s; valor só anexado para e, i, l (`-ia` é `-i`
 * com "a", e o comando vem depois); opção longa por prefixo único (`--arg` = `--arg-file`).
 * Opção desconhecida ou ambígua faz o xargs sair sem executar nada.
 * @param {string[]} args argumentos depois de `xargs`
 * @returns {{ index: number, argFiles: string[] }} índice do comando e arquivos de `-a`
 */
function parseXargsOptions(args) {
  const required = 'adEILnPs';
  const optional = 'eil';
  /** @type {string[]} */
  const argFiles = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '--') return { index: i + 1, argFiles };
    if (!a.startsWith('-') || a === '-') break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const typed = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const prefixed = Object.keys(XARGS_LONG_OPTIONS).filter((n) => n.startsWith(typed));
      const name = Object.hasOwn(XARGS_LONG_OPTIONS, typed)
        ? typed
        : prefixed.length === 1
          ? prefixed[0]
          : undefined;
      let value = eq >= 0 ? a.slice(eq + 1) : null;
      if (name !== undefined && XARGS_LONG_OPTIONS[name] === 'required' && value === null) {
        i++;
        value = args[i] ?? '';
      }
      if (name === 'arg-file' && value !== null) argFiles.push(value);
      i++;
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const ch = a.charAt(j);
      if (optional.includes(ch)) break; // o resto do grupo é o valor
      if (required.includes(ch)) {
        let value = a.slice(j + 1);
        if (value === '') {
          i++;
          value = args[i] ?? '';
        }
        if (ch === 'a') argFiles.push(value);
        break;
      }
    }
    i++;
  }
  return { index: i, argFiles };
}

/**
 * `xargs [opções] comando`: os argumentos acrescentados vêm do stdin (pipe, `<`, `<<<`) ou
 * de `-a ARQUIVO`. Se a origem cita um segredo (`find -name '.env*' | xargs cat`), nega;
 * se é desconhecida e o comando despeja conteúdo (`... | xargs cat`), pede confirmação.
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 * @returns {{ argv: string[], dynamic: boolean[] } | 'stop'}
 */
function unwrapXargs(args, dynamic, cmd, all, ctx, v) {
  const { index: i, argFiles } = parseXargsOptions(args);
  for (const file of argFiles) {
    for (const candidate of pathCandidates(file)) {
      const secret = classifySecretPath(candidate);
      if (secret) {
        v.deny(`xargs -a lê ${secret.reason}; bloqueado.`);
        return 'stop';
      }
    }
  }
  const rest = slice(args, dynamic, i);
  const target = path.posix.basename(rest.argv[0] ?? 'echo');
  const index = all.indexOf(cmd);
  const upstream = cmd.pipedIn
    ? all.filter((c, k) => k < index && c.pipeline === cmd.pipeline)
    : [];
  const feedsSecret =
    upstream.some((c) => commandMentionsSecret(c, ctx)) || cmd.hereStrings.some(textMentionsSecret);
  if (feedsSecret && !SECRET_NAME_ONLY_BINS.has(target)) {
    v.deny(
      `xargs ${target} recebe caminho de segredo pela entrada (find/echo/ls de .env*, chaves...); bloqueado.`,
    );
    return 'stop';
  }
  const unknownInput =
    cmd.pipedIn ||
    argFiles.length > 0 ||
    cmd.redirects.some((r) => r.op === '<') ||
    cmd.heredocs.length > 0;
  if (unknownInput && CONTENT_DUMPERS.has(target)) {
    v.ask(
      `xargs ${target} com lista de arquivos vinda da entrada; confirme que não inclui segredos.`,
    );
  }
  if (rest.argv.length === 0) return { argv: ['echo'], dynamic: [false] };
  // Os argumentos que o xargs acrescenta vêm do stdin: desconhecidos.
  return { argv: [...rest.argv, '{xargs}'], dynamic: [...rest.dynamic, true] };
}

/**
 * Algum argumento ou here-string do comando cita um segredo (`find -name '.env*'`,
 * `echo .env`, `printf '%s' id_rsa`)? Corpos de heredoc são dados e não contam.
 * @param {SimpleCommand} cmd
 * @param {PolicyContext} ctx
 */
function commandMentionsSecret(cmd, ctx) {
  const words = cmd.words.flatMap((w, k) =>
    cmd.dynamic[k] ? expandWord(w, ctx.vars).values : [w],
  );
  return [...words, ...cmd.hereStrings].some(textMentionsSecret);
}

/**
 * @param {string} text
 */
function textMentionsSecret(text) {
  return String(text)
    .split(/\s+/)
    .some((token) => pathCandidates(token).some((c) => classifySecretPath(c) !== null));
}

/**
 * O script (corpo de `$(...)`, crase) cita um segredo em algum comando?
 * @param {string} script
 * @param {PolicyContext} ctx
 * @param {number} [depth]
 * @returns {boolean}
 */
function scriptMentionsSecret(script, ctx, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  const parsed = parseShell(script);
  return parsed.commands.some(
    (c) =>
      commandMentionsSecret(c, ctx) ||
      c.substitutions.some((s) => scriptMentionsSecret(s, ctx, depth + 1)),
  );
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
 * Texto que `echo`/`printf` com argumentos literais geram (o script de `echo 'x' | sh` ou de
 * `bash <(printf 'x')`). `null` quando há outro comando ou argumento dinâmico.
 * @param {SimpleCommand[]} cmds
 * @returns {string | null}
 */
function generatedScript(cmds) {
  if (cmds.length === 0) return null;
  /** @type {string[]} */
  const parts = [];
  for (const c of cmds) {
    const bin = effectiveBin(c);
    if ((bin !== 'echo' && bin !== 'printf') || c.dynamic.some(Boolean)) return null;
    const at = c.words.findIndex((w) => path.posix.basename(w) === bin);
    let args = c.words.slice(at + 1);
    if (bin === 'echo') while (/^-[neE]+$/.test(args[0] ?? '')) args = args.slice(1);
    else if (args[0] === '--') args = args.slice(1);
    let text = args.join(' ');
    if (bin === 'printf') text = text.replace(/%[-+ #0-9.]*[sbqd]/g, ' ');
    parts.push(text.replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
  }
  return parts.join('\n');
}

/**
 * Analisa como script o texto gerado por `echo`/`printf` que vai ser executado.
 * @param {SimpleCommand[]} producers
 * @param {string} bin interpretador que recebe o texto
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function analyzeGeneratedScript(producers, bin, ctx, depth, v) {
  const text = generatedScript(producers);
  if (text === null) return;
  if (SHELL_BINS.has(bin)) analyzeScript(text, ctx, depth + 1, v);
  else checkInlineCode(text, v, ctx, languageOf(bin), depth + 1);
}

/**
 * Regra de pipe para interpretador (`curl ... | bash`, `base64 -d | sh`).
 * @param {SimpleCommand} cmd
 * @param {SimpleCommand[]} all
 * @param {Verdict} v
 * @param {string} [bin]
 * @param {PolicyContext} [ctx]
 * @param {number} [depth]
 */
function checkPipeIntoInterpreter(cmd, all, v, bin, ctx, depth = 0) {
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
  if (bin && ctx) analyzeGeneratedScript(upstream, bin, ctx, depth, v);
  v.ask('Conteúdo enviado por pipe para um interpretador; confirme o que será executado.');
}

/**
 * `bash <(...)`, `bash < <(...)`, `source <(...)`: o corpo da substituição de processo gera
 * o script que será executado.
 * @param {string} label
 * @param {SimpleCommand} cmd
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 * @param {string} [bin] interpretador que recebe o script (`bash` por padrão)
 */
function checkProcessSubstitutionScript(label, cmd, ctx, depth, v, bin = 'bash') {
  if (cmd.processSubstitutions.some(scriptFetchesNetwork)) {
    v.deny(`Executar script baixado da rede (${label} <(curl ...)) é proibido (supply chain).`);
    return;
  }
  for (const body of cmd.processSubstitutions) {
    const parsed = parseShell(body);
    if (parsed.commands.some(isDecoderCommand)) {
      v.deny(`Executar conteúdo decodificado via ${label} <(...) é proibido: padrão de ofuscação.`);
      return;
    }
    analyzeGeneratedScript(parsed.commands, bin, ctx, depth, v);
  }
  v.ask(`${label} executa o script gerado por <(...); confirme o que será executado.`);
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
  // `bash -c -e 'cmd'`, `bash -eo pipefail -c 'cmd'`, `fish -C 'cmd'`: o script é achado
  // lendo as opções como o shell lê (lib/cli-options.mjs).
  const parsed = parseShellArgs(bin, args);
  for (const rc of parsed.sourced) {
    checkSecretMentions(bin, [rc.value], [rc.index >= 0 && (dynamic[rc.index] ?? false)], v, ctx);
  }
  const fileArg = parsed.file?.value ?? null;
  if (parsed.scripts.length > 0) {
    for (const script of parsed.scripts) {
      if (script.index >= 0 && dynamic[script.index]) {
        if (cmd.substitutions.some(scriptFetchesNetwork)) {
          v.deny('Executar código baixado da rede (sh -c "$(curl ...)") é proibido.');
        } else {
          v.ask(`${bin} -c com conteúdo dinâmico; confirme o que será executado.`);
        }
      }
      analyzeScript(script.code, ctx, depth + 1, v);
    }
    if (fileArg !== null) checkSecretMentions(bin, [fileArg], [false], v, ctx);
    return;
  }
  if (fileArg !== null && !STDIN_SCRIPT_PATH.test(fileArg)) {
    if (fileArg === '/dev/fd/63' && cmd.processSubstitutions.length > 0) {
      checkProcessSubstitutionScript(bin, cmd, ctx, depth, v);
      return;
    }
    checkSecretMentions(bin, [fileArg], [false], v, ctx);
    return;
  }
  if (cmd.redirects.some((r) => r.op === '<' && r.target === '/dev/fd/63')) {
    checkProcessSubstitutionScript(`${bin} <`, cmd, ctx, depth, v);
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
  checkPipeIntoInterpreter(cmd, all, v, bin, ctx, depth);
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
function checkSource(args, dynamic, cmd, all, ctx, depth, v) {
  const target = args[0];
  if (target === undefined) {
    if (cmd.redirects.some((r) => r.op === '<' && r.target === '/dev/fd/63')) {
      checkProcessSubstitutionScript('source', cmd, ctx, depth, v);
    } else if (cmd.pipedIn) checkPipeIntoInterpreter(cmd, all, v, 'bash', ctx, depth);
    return;
  }
  if (target === '/dev/fd/63' && cmd.processSubstitutions.length > 0) {
    checkProcessSubstitutionScript('source', cmd, ctx, depth, v);
    return;
  }
  /** @type {string[]} */
  let targets = [target];
  if (dynamic[0]) {
    const expanded = expandWord(target, ctx.vars);
    if (expanded.unresolved) {
      v.ask(`source com caminho dinâmico (${target}); confirme.`);
      return;
    }
    targets = expanded.values;
  }
  for (const value of targets) {
    for (const candidate of pathCandidates(value)) {
      const secret = classifySecretPath(candidate);
      if (secret) {
        v.deny(
          `Carregar ${secret.reason} no shell expõe segredos. Use variáveis já injetadas no ambiente.`,
        );
        return;
      }
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
  /** @type {string[]} */
  let targets = [target];
  if (redirect.dynamic) {
    if (target === '/dev/fd/63') return;
    const expanded = expandWord(target, ctx.vars);
    if (expanded.unresolved) {
      if (op !== '<') v.ask(`Redirecionamento para destino dinâmico (${target}); confirme.`);
      else checkSecretMentions('cat', expanded.values, [false], v, ctx);
      return;
    }
    targets = expanded.values;
  }
  for (const value of targets) {
    for (const candidate of pathCandidates(value)) {
      const secret = classifySecretPath(candidate);
      if (secret) {
        v.deny(`Redirecionamento envolvendo ${secret.reason} bloqueado.`);
        return;
      }
    }
    if (op !== '<') checkWriteTarget(value, ctx, v, 'redirecionamento');
  }
}

/** Comandos que só mudam metadados (permissão, dono), não o conteúdo. */
const METADATA_BINS = new Set(['chmod', 'chown', 'chgrp', 'chattr']);
/** Programas que copiam/extraem árvores inteiras para o destino. */
const TREE_WRITERS = new Set([
  'cp',
  'mv',
  'rsync',
  'install',
  'ln',
  'tar',
  'unzip',
  'git checkout',
  'git restore',
]);

/**
 * Regras para qualquer escrita (redirecionamento, tee, cp, mv, sed -i, rm...). Um alvo
 * relativo é avaliado contra todos os diretórios possíveis depois de `cd`.
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
  const expanded = target.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
  if (path.isAbsolute(expanded)) {
    checkWriteAbs(path.resolve(expanded), ctx, v, how);
    return;
  }
  if (ctx.cwdUnknown) {
    v.ask(
      `Escrita em caminho relativo (${target}) depois de cd para destino que não dá para resolver; confirme.`,
    );
  }
  for (const cwd of cwdCandidates(ctx)) checkWriteAbs(path.resolve(cwd, expanded), ctx, v, how);
}

/**
 * @param {string} abs
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 * @param {string} how
 */
function checkWriteAbs(abs, ctx, v, how) {
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
  // Configuração do Claude Code no escopo do usuário (~/.claude/settings.json): mesclada com a
  // do projeto, desliga os guardas. Negada mesmo fora do projeto.
  const userRaw = userClaudeConfigLevel(abs);
  const userLevel = userRaw === 'deny' && METADATA_BINS.has(how) ? 'ask' : userRaw;
  if (userLevel === 'deny') {
    v.deny(
      `Alterar ${abs} (configuração do Claude Code no escopo do usuário) por Bash desligaria os guardas. Use a ferramenta Edit: o guard-files pede confirmação humana para esse arquivo.`,
    );
  } else if (userLevel === 'ask') {
    v.ask(`Alteração em ~/.claude (configuração do agente) via ${how}; confirme.`);
  }
  const rel = path.relative(ctx.projectDir, abs).split(path.sep).join('/');
  const insideProject = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (insideProject) {
    // Um glob (`.cl?ude/settings.json`, `.claude/se*`, `.claude/{settings,hooks}`) expande no
    // shell para a configuração protegida, mas chega aqui literal: testa o glob também.
    const exact = protectedConfigLevel(rel);
    const glob = exact === null ? protectedGlobMatch(rel) : null;
    const raw = exact ?? glob?.level ?? null;
    const level = raw === 'deny' && METADATA_BINS.has(how) ? 'ask' : raw;
    if (level === 'deny') {
      v.deny(
        `Alterar ${rel} por Bash desligaria as proteções do agente. Use a ferramenta Edit: o guard-files pede confirmação humana para esse caminho.`,
      );
    } else if (level === 'ask' && glob?.unresolved) {
      v.ask(
        `Escrita em glob longo demais (ou com chaves demais) para análise (${rel.slice(0, 80)}) via ${how}; confirme o destino.`,
      );
    } else if (level === 'ask') {
      v.ask(`Alteração de configuração de hooks/MCP (${rel}) via ${how}; confirme.`);
    } else if (rel === '.claude' && TREE_WRITERS.has(how)) {
      v.ask(
        `${how} copiando para dentro de .claude/ pode sobrescrever hooks e settings do agente; confirme.`,
      );
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
 * Opções longas de cp/mv/install/ln com valor obrigatório, que pode vir no argumento seguinte
 * (`--suffix .bak`), como [nome, tamanho mínimo do prefixo único] (coreutils 9).
 * @type {Record<string, ReadonlyArray<readonly [string, number]>>}
 */
const COPY_LONG_VALUE = {
  cp: [
    ['--no-preserve', 6],
    ['--sparse', 4],
    ['--suffix', 4],
  ],
  mv: [['--suffix', 4]],
  install: [
    ['--group', 3],
    ['--mode', 3],
    ['--owner', 3],
    ['--suffix', 4],
    ['--strip-program', 8],
  ],
  ln: [['--suffix', 4]],
};

/**
 * Operandos de cp/mv/install/ln. `dir` é a pasta de destino explícita: `-t DIR`, `-tDIR`,
 * `-at`/`-vt DIR` (t no fim de um agrupamento), `--target-directory DIR`/`=DIR` e qualquer
 * prefixo único (`--t`, `--targ`...). Letras de valor (install `m`,`o`,`g`; `S` sufixo) e
 * opções longas com valor separado (`--suffix .bak`, `--mode 644`) consomem o valor, que não
 * vira operando: o GNU aceita opções depois dos operandos, então `cp x DEST --suffix .bak`
 * não pode transformar `.bak` em destino. `-T` (`--no-target-directory`) trata o destino como
 * arquivo.
 * @param {string} bin
 * @param {string[]} args
 * @returns {{ dir: string | null, operands: string[], noTargetDir: boolean }}
 */
function copyMoveOperands(bin, args) {
  const shortValue = bin === 'install' ? 'mogS' : 'S';
  const longValue = COPY_LONG_VALUE[bin] ?? [];
  /** @type {string | null} */
  let dir = null;
  let noTargetDir = false;
  /** @type {string[]} */
  const operands = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? '';
    if (a === '--') {
      operands.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      if (name.length >= 3 && '--target-directory'.startsWith(name)) {
        dir = eq >= 0 ? a.slice(eq + 1) : (args[k + 1] ?? '');
        if (eq < 0) k++;
      } else if (name.length >= 6 && '--no-target-directory'.startsWith(name)) {
        noTargetDir = true;
      } else if (
        eq < 0 &&
        longValue.some(([full, min]) => name.length >= min && full.startsWith(name))
      ) {
        k++;
      }
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      for (let c = 1; c < a.length; c++) {
        const ch = a.charAt(c);
        if (ch === 'T') noTargetDir = true;
        if (ch === 't') {
          const rest = a.slice(c + 1);
          dir = rest !== '' ? rest : (args[k + 1] ?? '');
          if (rest === '') k++;
          break;
        }
        if (shortValue.includes(ch)) {
          if (c === a.length - 1) k++;
          break;
        }
      }
      continue;
    }
    operands.push(a);
  }
  return { dir, operands, noTargetDir };
}

/**
 * O destino de uma cópia pode ser uma pasta? Sim com `/` no fim, glob ou expansão (o shell
 * decide), cwd desconhecido ou pasta existente em algum cwd candidato. Um arquivo comum
 * (`cp pnpm-lock.yaml pnpm-lock.yaml.bak`) não é.
 * @param {string} dest
 * @param {PolicyContext} ctx
 */
function mayBeDirectory(dest, ctx) {
  if (dest.endsWith('/') || /[*?[{$`]/.test(dest)) return true;
  const expanded = dest.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
  if (path.isAbsolute(expanded)) return isDirectory(expanded);
  if (ctx.cwdUnknown) return true;
  return cwdCandidates(ctx).some((base) => isDirectory(path.resolve(base, expanded)));
}

/** @param {string} p */
function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Destinos de cp/mv/install/ln. Com pasta de destino (`-t DIR`, `cp x .claude/`, `cp x
 * .claude` com `.claude` existente), cada origem vira DIR/basename(origem): `cp settings.json
 * .claude/` grava `.claude/settings.json`. A própria pasta também é alvo (cópia de árvore
 * para dentro de `.claude/` pede confirmação). `ln` com um só operando cria o link no cwd.
 * @param {string} bin
 * @param {string[]} args
 * @param {PolicyContext} ctx
 * @returns {string[]}
 */
function copyMoveTargets(bin, args, ctx) {
  const { dir, operands, noTargetDir } = copyMoveOperands(bin, args);
  /**
   * @param {string} d
   * @param {string[]} sources
   */
  const into = (d, sources) => [
    d,
    ...sources.map((s) => path.posix.join(d, path.posix.basename(s.replace(/\/+$/, '') || s))),
  ];
  if (dir !== null) return into(dir, operands);
  const dest = operands.at(-1);
  if (dest === undefined) return [];
  if (operands.length === 1) return bin === 'ln' ? [path.posix.basename(dest)] : [dest];
  if (noTargetDir || !mayBeDirectory(dest, ctx)) return [dest];
  return into(dest, operands.slice(0, -1));
}

/**
 * Alvos de escrita de uma extração `tar -x`: o diretório `-C`/`--directory` (separado, colado
 * `-C.claude` ou em agrupamento `-xC dir`) e cada membro nomeado (resolvido contra o `-C`).
 * `tar -xf x.tar .claude/settings.json` escreve `.claude/settings.json`.
 * @param {string[]} args
 * @returns {string[]}
 */
function tarExtractTargets(args) {
  const first = args[0] ?? '';
  const oldStyle = !first.startsWith('-') && /^[A-Za-wyz]*[cxtru][A-Za-z]*$/.test(first);
  const extract =
    args.some((a) => a === '--extract' || a === '--get' || /^-[A-Za-z]*x/.test(a)) ||
    (oldStyle && first.includes('x'));
  if (!extract) return [];
  let dir = '.';
  /** quantos posicionais ainda são valores de opção (f=arquivo, old-style) e não membros */
  let archivePending = oldStyle && first.includes('f') ? 1 : 0;
  /** @type {string[]} */
  const members = [];
  const start = oldStyle ? 1 : 0;
  // Opções curtas de tar que levam valor no próximo argumento (as relevantes aqui).
  for (let k = start; k < args.length; k++) {
    const a = args[k] ?? '';
    if (a === '--') {
      for (let j = k + 1; j < args.length; j++) members.push(args[j] ?? '');
      break;
    }
    if (a === '-C' || a === '--directory') {
      dir = args[k + 1] ?? '.';
      k++;
      continue;
    }
    if (a.startsWith('--directory=')) {
      dir = a.slice('--directory='.length);
      continue;
    }
    if (a === '-f' || a === '--file') {
      k++;
      continue;
    }
    if (a.startsWith('--file=')) continue;
    if (a.startsWith('--')) continue;
    if (a.startsWith('-') && a !== '-') {
      // Agrupamento: `-C`/`-f` colados ou no fim consomem valor; `-C.claude`, `-xC dir`, `-xf a`.
      const ci = a.indexOf('C');
      if (ci > 0) {
        const rest = a.slice(ci + 1);
        if (rest !== '') dir = rest;
        else {
          dir = args[k + 1] ?? '.';
          k++;
        }
        continue;
      }
      const fi = a.indexOf('f');
      if (fi > 0 && a.slice(fi + 1) === '') k++; // `-xf arquivo`
      continue;
    }
    if (archivePending > 0) {
      archivePending--;
      continue;
    }
    members.push(a);
  }
  const resolved = members
    .filter((m) => m !== '')
    .map((m) => (dir === '.' ? m : path.posix.join(dir, m)));
  return [dir, ...resolved];
}

/**
 * Lista os caminhos que um comando conhecido vai escrever ou apagar.
 * @param {string} bin
 * @param {string[]} args
 * @param {PolicyContext} ctx
 * @returns {string[]}
 */
function writeTargets(bin, args, ctx) {
  const positionals = args.filter((a) => !a.startsWith('-'));
  switch (bin) {
    case 'tee':
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
    case 'truncate':
    case 'rimraf':
      return positionals;
    case 'mv': {
      // mv remove as origens e escreve o destino (pasta/basename(origem) quando é pasta).
      const t = copyMoveTargets('mv', args, ctx);
      return [...positionals, ...t.filter((x) => !positionals.includes(x))];
    }
    case 'cp':
    case 'install':
    case 'ln':
      // Destino por `-t DIR`, `-tDIR`, `-at`/`-vt DIR`, `--target-directory[=]` (e abreviações)
      // ou o último operando; numa pasta, cada origem vira pasta/basename(origem).
      return copyMoveTargets(bin, args, ctx);
    case 'rsync': {
      // rsync não tem --target-directory; o destino é o último posicional (`-t` é --times).
      const last = positionals.at(-1);
      return last ? [last] : [];
    }
    case 'chmod':
    case 'chown':
    case 'chgrp':
    case 'chattr':
      return modeChangeOperands(bin, args).targets;
    case 'sed':
    case 'gsed': {
      const parsed = parseSedArgs(args);
      return parsed.inPlace ? parsed.files : [];
    }
    case 'perl':
    case 'ruby': {
      const parsed = parseInPlaceInterpreter(bin, args);
      return parsed.inPlace ? parsed.files : [];
    }
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk': {
      const parsed = parseAwkArgs(args);
      return parsed.inPlace ? parsed.files : [];
    }
    case 'ex':
    case 'ed':
    case 'red':
    case 'vim':
    case 'vi':
    case 'nvim':
    case 'view':
    case 'gvim':
      return editorTargets(bin, args);
    case 'tar':
      return tarExtractTargets(args);
    case 'unzip': {
      // `-d DIR`, `-d.claude` (colado) ou extração no cwd; mais os membros nomeados.
      let dir = '.';
      for (let k = 0; k < args.length; k++) {
        const a = args[k] ?? '';
        if (a === '-d') dir = args[k + 1] ?? '.';
        else if (/^-d./.test(a)) dir = a.slice(2);
      }
      return [dir];
    }
    case 'sort': {
      /** @type {string[]} */
      const out = [];
      args.forEach((a, k) => {
        if ((a === '-o' || a === '--output') && args[k + 1]) out.push(args[k + 1] ?? '');
        else if (a.startsWith('--output=')) out.push(a.slice('--output='.length));
        else if (/^-o./.test(a)) out.push(a.slice(2));
      });
      return out;
    }
    case 'uniq':
      return positionals.slice(1, 2);
    case 'find': {
      /** @type {string[]} */
      const out = [];
      args.forEach((a, k) => {
        if (/^-(?:fprint0?|fprintf|fls)$/.test(a) && args[k + 1]) out.push(args[k + 1] ?? '');
      });
      return out;
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
 * Edição em lote com vim/ex/ed: os arquivos citados são escritos.
 * @param {string} bin
 * @param {string[]} args
 * @returns {string[]}
 */
function editorTargets(bin, args) {
  const isVim = /^(?:vim|vi|nvim|view|gvim)$/.test(bin);
  const batch = args.some(
    (a) => /^-[a-zA-Z]*[eEs][a-zA-Z]*$/.test(a) || a === '-c' || a === '--cmd' || /^\+/.test(a),
  );
  if (isVim && !batch) return [];
  const exMode = !isVim || args.some((a) => /^-[a-zA-Z]*[eE][a-zA-Z]*$/.test(a));
  const valueOpts = new Set([
    '-c',
    '--cmd',
    '-S',
    '-u',
    '-U',
    '-i',
    '-T',
    '-w',
    '-W',
    '-t',
    '-q',
    '-r',
  ]);
  if (!exMode) valueOpts.add('-s');
  /** @type {string[]} */
  const files = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? '';
    if (a === '--') {
      files.push(...args.slice(k + 1));
      break;
    }
    if (valueOpts.has(a) || /^-[a-zA-Z]+c$/.test(a)) {
      k++;
      continue;
    }
    if (a.startsWith('-') || a.startsWith('+')) continue;
    files.push(a);
  }
  return files;
}

// `!` de shell num comando Ex, aceitando `:` iniciais e uma faixa (`%`, `1,$`, `.`, `'a`,
// `/pat/`) antes do `!`; captura o texto do shell depois do `!`. `:r!cmd`, `:r !cmd` e
// `:w !cmd` (com espaço) chamam o shell; `:w!arquivo` é gravação forçada, não shell.
const EX_BANG =
  /(?:^|\|)[\s:]*(?:(?:%|[.$]|\d+|'[a-z<>]|\/[^/]*\/|\?[^?]*\?)(?:[+-]\d*)*(?:\s*[,;]\s*(?:%|[.$]|\d+|'[a-z<>]|\/[^/]*\/)(?:[+-]\d*)*)?\s*)?(?:sil(?:ent)?!?\s+)?(?:r(?:e(?:ad?)?)?\s*|w(?:r(?:i(?:te?)?)?)?(?:\s+|!\s*(?=!)))?!(.*)$/;
/** Outras formas de execução num comando Ex (`:terminal`, `:python`, `:execute`...). */
const EX_EXEC =
  /\b(?:te(?:rminal)?|py(?:thon)?3?|lua|perl|ruby|exe(?:cute)?|norm(?:al)?|sh(?:ell)?|call\s+(?:system|systemlist|jobstart|termopen))\b/;
/** Funções do Vimscript que executam comando ou mexem em arquivo. */
const VIM_FUNCTION_CALL =
  /\b(?:system|systemlist|jobstart|termopen|job_start|term_start|libcall|libcallnr|writefile|readfile|readblob|delete|rename|filecopy|setfperm|luaeval|pyeval|py3eval|pyxeval|perleval|rubyeval)\s*\(/;
/** Literal de string do Vimscript (`'...'` ou `"..."`). */
const VIM_STRING = /(['"])((?:(?!\1)[^\\]|\\.){0,500})\1/g;

/**
 * Texto do shell depois de um `!` num comando Ex; `null` quando não há `!` de shell.
 * @param {string} cmd
 * @returns {string | null}
 */
function exBangCommand(cmd) {
  const m = EX_BANG.exec(cmd);
  return m ? (m[1] ?? '') : null;
}

/**
 * Textos de comando Ex passados ao vim/ex: `-c CMD`, `--cmd CMD`, `-cCMD` (anexado), o `c`
 * de um agrupamento de opções curtas (`-sc CMD`, `-esc CMD`, `-ec CMD`, `-sc!cmd`) e `+CMD`.
 * Para em `--` (dali em diante tudo é nome de arquivo).
 * @param {string[]} args
 * @returns {string[]}
 */
function editorCommandTexts(args) {
  /** @type {string[]} */
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? '';
    if (a === '--') break;
    if (a === '--cmd') {
      if (k + 1 < args.length) out.push(args[k + 1] ?? '');
      k++;
      continue;
    }
    if (a.startsWith('+')) {
      if (a.length > 1) out.push(a.slice(1));
      continue;
    }
    if (!/^-[a-zA-Z]/.test(a)) continue;
    for (let i = 1; i < a.length; i++) {
      const ch = a.charAt(i);
      if (ch === 'c') {
        const rest = a.slice(i + 1);
        if (rest !== '') out.push(rest);
        else if (k + 1 < args.length) {
          out.push(args[k + 1] ?? '');
          k++;
        }
        break;
      }
      // Letras cujo valor é o resto do argumento (`-t{tag}`, `-V9arquivo`) ou o próximo.
      if ('tqVSuUiTWw'.includes(ch)) break;
    }
  }
  return out;
}

/**
 * Comandos Ex como [nome completo, abreviação mínima], na grafia do `:help` (`:w[rite]` =
 * ['write', 1]): o nome digitado casa quando é prefixo do completo e tem o tamanho mínimo.
 * @typedef {ReadonlyArray<readonly [string, number]>} ExNames
 */

/** @type {ExNames} Gravam no arquivo do argumento (`:file` troca o nome que o `:w` grava). */
const EX_WRITE = [
  ['write', 1],
  ['wq', 2],
  ['xit', 1],
  ['exit', 3],
  ['saveas', 3],
  ['update', 2],
  ['wnext', 2],
  ['wNext', 2],
  ['wprevious', 2],
  ['file', 1],
  ['mksession', 3],
  ['mkview', 5],
  ['mkvimrc', 3],
  ['mkexrc', 2],
  ['wviminfo', 2],
  ['wshada', 3],
  ['wundo', 2],
];
/** @type {ExNames} Abrem o arquivo num buffer, que um `:w`/`:x` seguinte grava. */
const EX_OPEN = [
  ['edit', 1],
  ['ex', 2],
  ['visual', 2],
  ['view', 3],
  ['split', 2],
  ['vsplit', 2],
  ['new', 3],
  ['vnew', 3],
  ['sview', 2],
  ['tabedit', 4],
  ['tabnew', 6],
  ['find', 3],
  ['sfind', 2],
  ['tabfind', 4],
  ['badd', 3],
  ['balt', 4],
  ['argadd', 4],
  ['argedit', 4],
  ['args', 2],
  ['next', 1],
  ['snext', 2],
  ['drop', 2],
  ['pedit', 3],
  ['diffsplit', 5],
];
/** @type {ExNames} */
const EX_READ = [['read', 1]];
/** @type {ExNames} Executam um arquivo como script (Vim, Lua, Python, Ruby, Tcl, MzScheme). */
const EX_SOURCE = [
  ['source', 2],
  ['luafile', 4],
  ['pyfile', 3],
  ['py3file', 4],
  ['pyxfile', 4],
  ['rubyfile', 5],
  ['mzfile', 3],
  ['tclfile', 4],
];
/** @type {ExNames} Executam código da própria linha em cada linha do buffer. */
const EX_CODE = [
  ['luado', 5],
  ['pydo', 3],
  ['py3do', 4],
  ['pyxdo', 4],
  ['perldo', 5],
  ['rubydo', 5],
  ['tcldo', 4],
];
/** @type {ExNames} */
const EX_CD = [
  ['cd', 2],
  ['chdir', 3],
  ['lcd', 2],
  ['lchdir', 3],
  ['tcd', 2],
  ['tchdir', 3],
];
/** @type {ExNames} */
const EX_REDIR = [['redir', 4]];
/** @type {ExNames} `:g/pad/cmd` e `:v/pad/cmd` executam `cmd` em cada linha. */
const EX_GLOBAL = [
  ['global', 1],
  ['vglobal', 1],
];
/** @type {ExNames} Executam o comando do argumento em cada janela, buffer, item... */
const EX_EACH = [
  ['windo', 5],
  ['bufdo', 5],
  ['argdo', 5],
  ['tabdo', 5],
  ['cdo', 3],
  ['ldo', 3],
  ['cfdo', 4],
  ['lfdo', 4],
];
/** @type {ExNames} Modificadores que precedem outro comando (`:silent! keepalt w x`). */
const EX_MODIFIERS = [
  ['silent', 3],
  ['unsilent', 3],
  ['keepalt', 5],
  ['keepjumps', 5],
  ['keepmarks', 3],
  ['keeppatterns', 5],
  ['lockmarks', 5],
  ['noautocmd', 3],
  ['noswapfile', 3],
  ['confirm', 4],
  ['browse', 3],
  ['vertical', 4],
  ['horizontal', 3],
  ['leftabove', 5],
  ['aboveleft', 3],
  ['rightbelow', 6],
  ['belowright', 3],
  ['topleft', 2],
  ['botright', 2],
  ['tab', 3],
  ['hide', 3],
  ['sandbox', 3],
];
/** Parte de uma faixa Ex (`%`, `1,$`, `'<,'>`, `.+1`, `/pad/;?pad?`) ou `:`/espaço iniciais. */
const EX_RANGE_PART =
  /^(?:[\s:,;]+|[%.$*]|\d+|'.|\/(?:\\.|[^\\/])*\/?|\?(?:\\.|[^\\?])*\??|\\[/?&]|[+-]\d*)/;

/**
 * @param {string} name
 * @param {ExNames} names
 */
function exNameIs(name, names) {
  return names.some(([full, min]) => name.length >= min && full.startsWith(name));
}

/** @param {string} text */
function stripExRange(text) {
  let s = text;
  for (let guard = 0; guard < 64; guard++) {
    const m = EX_RANGE_PART.exec(s);
    if (!m || m[0] === '') return s;
    s = s.slice(m[0].length);
  }
  return s;
}

/**
 * Separa `texto|resto` no primeiro `|` sem `\` antes.
 * @param {string} text
 * @returns {[string, string]}
 */
function splitExBar(text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '\\') i++;
    else if (ch === '|') return [text.slice(0, i), text.slice(i + 1)];
  }
  return [text, ''];
}

/**
 * Separa o argumento de um comando Ex de arquivo em nomes (espaço sem `\` separa; o escape
 * fica, para `exFileName` saber o que é literal), ignora `++opt` e devolve `+cmd` à parte.
 * @param {string} arg
 * @returns {{ files: string[], cmds: string[] }}
 */
function exFileArgs(arg) {
  /** @type {string[]} */
  const words = [];
  let current = '';
  for (let i = 0; i < arg.length; i++) {
    const ch = arg.charAt(i);
    if (ch === '\\' && i + 1 < arg.length) {
      current += ch + arg.charAt(i + 1);
      i++;
    } else if (/\s/.test(ch)) {
      if (current !== '') words.push(current);
      current = '';
    } else current += ch;
  }
  if (current !== '') words.push(current);
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const cmds = [];
  for (const word of words) {
    if (word.startsWith('++')) continue;
    if (word.startsWith('+')) cmds.push(word.slice(1).replace(/\\(.)/g, '$1'));
    else files.push(word);
  }
  return { files, cmds };
}

/**
 * Nome de arquivo de um comando Ex como o vim o resolve: `$HOME` expandido e escapes
 * removidos. `null` quando só o vim sabe o nome: `%`/`#` (arquivo atual/alternativo, inclusive
 * com modificadores como `%:h`), `<cfile>` e afins, ou outra variável de ambiente.
 * @param {string} raw
 * @returns {string | null}
 */
function exFileName(raw) {
  if (
    /(?:^|[^\\])[%#]|<(?:cfile|cword|cWORD|cexpr|afile|abuf|amatch|sfile|stack|script|slnum|sflnum|client)>/.test(
      raw,
    )
  ) {
    return null;
  }
  const home = process.env.HOME;
  const expanded = home ? raw.replace(/\$(?:\{HOME\}|HOME\b)/g, () => home) : raw;
  if (/(?:^|[^\\])\$/.test(expanded)) return null;
  return expanded.replace(/\\(.)/g, '$1');
}

/**
 * Arquivos e comandos que as linhas de comando Ex de um vim usam.
 * @typedef {object} ExUse
 * @property {string[]} writes arquivos gravados (ou abertos num buffer que `:w` grava)
 * @property {string[]} reads arquivos lidos
 * @property {string[]} shell textos que o vim passa ao shell (`:!`, `:r !`, `:w !`, crase)
 * @property {string[]} unresolved nomes que só o vim resolve
 * @property {string[]} cds diretório efetivo depois de cada `:cd`/`:lcd`/`:tcd`
 * @property {boolean} code executa script ou código que o guarda não lê
 */

/**
 * @param {string} arg
 * @param {string[]} list onde anotar os arquivos
 * @param {ExUse} use
 * @param {number} depth
 * @param {boolean} [alsoRead] o arquivo também é lido (aberto num buffer)
 */
function addExFiles(arg, list, use, depth, alsoRead = false) {
  if (arg.includes('`')) {
    // Crase: o vim roda o comando de shell (ou avalia `=expr`) para obter o nome.
    for (const m of arg.matchAll(/`([^`]*)`?/g)) {
      const inner = m[1] ?? '';
      if (inner.startsWith('=')) use.code = true;
      else use.shell.push(inner);
    }
    return;
  }
  const { files, cmds } = exFileArgs(arg);
  for (const cmd of cmds) scanExCommands(cmd, use, depth + 1);
  for (const raw of files) {
    const name = exFileName(raw);
    if (name === null) {
      use.unresolved.push(raw);
      continue;
    }
    list.push(name);
    if (alsoRead) use.reads.push(name);
  }
}

/**
 * Um comando Ex já separado: nome, `!` colado ao nome e argumento até o `|`.
 * @param {string} name
 * @param {boolean} bang
 * @param {string} arg
 * @param {ExUse} use
 * @param {number} depth
 */
function exFileCommand(name, bang, arg, use, depth) {
  const rest = arg.replace(/^(?:\+\+\S+\s*)+/, '');
  if (exNameIs(name, EX_WRITE)) {
    // `:w !cmd` manda o buffer para o shell; `:w!arquivo` só força a gravação.
    if (exNameIs(name, [['write', 1]]) && rest.startsWith('!')) use.shell.push(rest.slice(1));
    else addExFiles(rest.replace(/^>>\s*/, ''), use.writes, use, depth);
  } else if (exNameIs(name, EX_OPEN)) {
    addExFiles(arg, use.writes, use, depth, true);
  } else if (exNameIs(name, EX_READ)) {
    if (bang || rest.startsWith('!')) use.shell.push(bang ? rest : rest.slice(1));
    else addExFiles(rest, use.reads, use, depth);
  } else if (exNameIs(name, EX_REDIR)) {
    const m = /^>>?!?\s*(.*)$/.exec(arg);
    if (m) addExFiles(m[1] ?? '', use.writes, use, depth);
  } else if (exNameIs(name, EX_SOURCE)) {
    use.code = true;
    addExFiles(arg, use.reads, use, depth);
  } else if (exNameIs(name, EX_CODE)) {
    use.code = true;
  } else if (exNameIs(name, EX_CD)) {
    const first = exFileArgs(arg).files[0];
    const dir = first === undefined ? '~' : exFileName(first);
    if (dir === null || dir === '-') {
      use.unresolved.push(`:${name} ${arg}`);
      return;
    }
    const prev = use.cds.at(-1);
    const absolute = path.isAbsolute(dir) || dir.startsWith('~') || prev === undefined;
    use.cds.push(absolute ? dir : path.posix.join(prev, dir));
  }
}

/**
 * Percorre uma linha de comandos Ex (separados por `|`) e anota em `use` os arquivos gravados
 * e lidos, o shell chamado e o código executado. Entende faixa, modificadores (`:silent!`,
 * `:keepalt`...), `:g/pad/cmd`, `:bufdo cmd` e o `+cmd` dos comandos que abrem arquivo.
 * @param {string} text
 * @param {ExUse} use
 * @param {number} [depth]
 */
function scanExCommands(text, use, depth = 0) {
  if (depth > 4) {
    use.unresolved.push(text);
    return;
  }
  let rest = text;
  for (let guard = 0; guard < 64; guard++) {
    rest = stripExRange(rest);
    if (rest === '') return;
    if (rest.startsWith('!')) {
      use.shell.push(rest.slice(1));
      return;
    }
    // Nome: letras; `:py3`, `:py3file`... incluem dígitos (o vim faz o mesmo para `py`).
    const m = /^(py[a-zA-Z0-9]*|[a-zA-Z]+)(!?)\s*/.exec(rest);
    if (!m) {
      rest = splitExBar(rest)[1];
      continue;
    }
    const name = m[1] ?? '';
    const arg = rest.slice(m[0].length);
    if (exNameIs(name, EX_MODIFIERS)) {
      rest = arg;
      continue;
    }
    if (exNameIs(name, EX_GLOBAL)) {
      const delim = arg.charAt(0);
      let end = 1;
      while (end < arg.length && arg.charAt(end) !== delim) end += arg.charAt(end) === '\\' ? 2 : 1;
      scanExCommands(arg.slice(end + 1), use, depth + 1);
      return;
    }
    if (exNameIs(name, EX_EACH)) {
      scanExCommands(arg, use, depth + 1);
      return;
    }
    const [own, next] = splitExBar(arg);
    exFileCommand(name, m[2] === '!', own.trim(), use, depth);
    rest = next;
  }
}

/**
 * Arquivos de opções do vim. Gravados: `-w`/`-W` (teclas digitadas), `-i` (viminfo, gravado
 * ao sair), `--startuptime` e `-V[N]arquivo` (log). Executados como script: `-S` (sem valor,
 * Session.vim), `-u`/`-U` (exceto NONE, NORC, DEFAULTS) e `-s` fora do modo Ex (teclas).
 * @param {string} bin
 * @param {string[]} args
 * @returns {{ writes: string[], scripts: string[] }}
 */
function editorOptionFiles(bin, args) {
  const exMode =
    !/^(?:vim|vi|nvim|view|gvim)$/.test(bin) ||
    args.some((a) => /^-[a-zA-Z]*[eE][a-zA-Z]*$/.test(a));
  /** @type {string[]} */
  const writes = [];
  /** @type {string[]} */
  const scripts = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? '';
    if (a === '--') break;
    if (a === '--cmd') {
      k++;
      continue;
    }
    if (a === '--startuptime') {
      writes.push(args[k + 1] ?? '');
      k++;
      continue;
    }
    if (!/^-[a-zA-Z]/.test(a)) continue;
    const log = /^-V\d*(\D.*)$/.exec(a);
    if (log) {
      writes.push(log[1] ?? '');
      continue;
    }
    const letters = a.slice(1);
    // `c`, `t`, `q` e `V` antes do fim levam o resto do argumento como valor (`-cwq`).
    if (/[ctqV]/.test(letters.slice(0, -1))) continue;
    const letter = letters.charAt(letters.length - 1);
    if (!/^[wWiSuUs]$/.test(letter) || (letter === 's' && exMode)) continue;
    const value = args[k + 1];
    if (letter === 'S' && (value === undefined || value.startsWith('-'))) {
      scripts.push('Session.vim');
      continue;
    }
    k++;
    if (value === undefined) continue;
    if (/^[wWi]$/.test(letter)) {
      if (!(letter === 'i' && value === 'NONE')) writes.push(value);
    } else if (!(/^[uU]$/.test(letter) && /^(?:NONE|NORC|DEFAULTS)$/.test(value))) {
      scripts.push(value);
    }
  }
  return { writes, scripts };
}

/**
 * Vimscript com `system()`, `writefile()`, `readfile()`...: o texto literal passado ao shell
 * é analisado como script; caminho literal de segredo ou da configuração protegida é negado.
 * @param {string} text
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkVimFunctionCall(text, ctx, depth, v) {
  for (const m of text.matchAll(
    /\b(?:system|systemlist|jobstart|termopen|job_start|term_start)\s*\(\s*(['"])((?:(?!\1)[^\\]|\\.){1,500})\1/g,
  )) {
    analyzeScript(m[2] ?? '', ctx, depth + 1, v);
  }
  for (const m of text.matchAll(VIM_STRING)) {
    const literal = m[2] ?? '';
    for (const candidate of pathCandidates(literal)) {
      const secret = classifySecretPath(candidate);
      if (secret) {
        v.deny(`Vimscript acessando ${secret.reason} bloqueado.`);
        return;
      }
    }
    checkInlinePath(literal, true, ctx, v);
  }
}

/**
 * vim/ex/view/nvim: comandos Ex de `-c`, `--cmd` e `+cmd` (shell, arquivos gravados e lidos,
 * Vimscript) e opções que gravam ou executam arquivo, com o mesmo nível dos outros vetores de
 * escrita. Os arquivos passados como argumento já são alvos em `writeTargets` (modo lote);
 * aqui eles só são reavaliados contra os diretórios de `:cd`.
 * @param {string} bin
 * @param {string[]} args
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkEditor(bin, args, ctx, depth, v) {
  /** @type {ExUse} */
  const use = { writes: [], reads: [], shell: [], unresolved: [], cds: [], code: false };
  let calls = false;
  for (const text of editorCommandTexts(args)) {
    const bang = exBangCommand(text);
    if (bang !== null) use.shell.push(bang);
    else if (EX_EXEC.test(text)) calls = true;
    if (VIM_FUNCTION_CALL.test(text)) {
      calls = true;
      checkVimFunctionCall(text, ctx, depth, v);
    }
    scanExCommands(text, use);
  }
  const options = editorOptionFiles(bin, args);
  use.writes.push(...options.writes);
  use.reads.push(...options.scripts);
  if (options.scripts.length > 0) use.code = true;

  for (const command of use.shell) {
    if (command.trim() !== '') analyzeScript(command, ctx, depth + 1, v);
  }
  if (use.shell.length > 0 || calls) {
    v.ask(
      `${bin} com comando que chama o shell (-c '!...', system()); confirme o que será executado.`,
    );
  }
  if (use.code) {
    v.ask(
      `${bin} executa script ou código (:source, -S, -u, :luafile, :pydo...) que o guard-bash não lê; confirme.`,
    );
  }
  for (const raw of new Set(use.unresolved)) {
    v.ask(`${bin} usa arquivo cujo nome só o vim resolve (${raw}); confirme.`);
  }
  // Caminho relativo depois de `:cd`: vale também contra cada diretório por onde o vim passou.
  /** @param {string} file */
  const withCds = (file) =>
    path.isAbsolute(file) || file.startsWith('~')
      ? [file]
      : [file, ...use.cds.map((d) => path.posix.join(d, file))];
  for (const file of [...use.reads, ...use.writes].flatMap(withCds)) {
    const secret = classifySecretPath(file);
    if (secret) {
      v.deny(
        `${bin} acessando ${secret.reason} bloqueado. Segredos ficam fora do alcance do agente.`,
      );
      break;
    }
  }
  const positional = use.cds.length > 0 ? editorTargets(bin, args).flatMap(withCds) : [];
  for (const file of new Set([...use.writes.flatMap(withCds), ...positional])) {
    checkWriteTarget(file, ctx, v, bin);
  }
}

/** Opções longas do GNU sed (para resolver abreviações por prefixo único). */
const SED_LONG_OPTIONS = [
  '--debug',
  '--expression',
  '--file',
  '--follow-symlinks',
  '--in-place',
  '--line-length',
  '--null-data',
  '--posix',
  '--quiet',
  '--regexp-extended',
  '--sandbox',
  '--separate',
  '--silent',
  '--unbuffered',
  '--zero-terminated',
  '--help',
  '--version',
];

/**
 * Resolve uma opção longa do sed por prefixo único (`--i` -> `--in-place`, `--in-pl` ->
 * `--in-place`); devolve o nome exato ou `null` quando não existe ou é ambíguo.
 * @param {string} name
 * @returns {string | null}
 */
function resolveSedLongOption(name) {
  if (name === '--') return null;
  const hits = SED_LONG_OPTIONS.filter((o) => o === name || o.startsWith(name));
  if (hits.includes(name)) return name;
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * Argumentos de `sed`: in-place, scripts (posicional ou -e/--expression), arquivos de script
 * (-f) e arquivos de entrada. `-Ei`, `-iE`, `-i.bak`, `--in-place=SUF` contam como in-place.
 * @param {string[]} args
 */
function parseSedArgs(args) {
  let inPlace = false;
  /** @type {string[]} */
  const scripts = [];
  /** @type {string[]} */
  const scriptFiles = [];
  /** @type {string[]} */
  const positionals = [];
  let endOfOptions = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? '';
    if (!endOfOptions && a === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      const value = eq >= 0 ? a.slice(eq + 1) : undefined;
      // O getopt_long do GNU sed aceita qualquer prefixo único: `--in`/`--in-pl`/`--i` =
      // `--in-place`. `--i` é único (nenhum outro longo do sed começa com i).
      const resolved = resolveSedLongOption(name);
      if (resolved === '--in-place') inPlace = true;
      else if (resolved === '--expression') scripts.push(value ?? args[++k] ?? '');
      else if (resolved === '--file') scriptFiles.push(value ?? args[++k] ?? '');
      else if (resolved === '--line-length' && value === undefined) k++;
      continue;
    }
    if (!endOfOptions && a.startsWith('-') && a !== '-') {
      for (let c = 1; c < a.length; c++) {
        const flag = a.charAt(c);
        if (flag === 'i') {
          inPlace = true;
          break;
        }
        if (flag === 'e' || flag === 'f' || flag === 'l') {
          const rest = a.slice(c + 1);
          const value = rest !== '' ? rest : (args[++k] ?? '');
          if (flag === 'e') scripts.push(value);
          else if (flag === 'f') scriptFiles.push(value);
          break;
        }
      }
      continue;
    }
    positionals.push(a);
  }
  const positionalScript = scripts.length === 0 && scriptFiles.length === 0;
  if (positionalScript && positionals.length > 0) scripts.push(positionals[0] ?? '');
  return {
    inPlace,
    scripts,
    scriptFiles,
    files: positionalScript ? positionals.slice(1) : positionals,
  };
}

/**
 * Comandos de um script sed que leem (`r`/`R`), escrevem (`w`/`W`, flag `w` do `s`) ou
 * executam (`e`, flag `e` do `s`). `null` quando o script não é reconhecível.
 * @param {string} script
 * @returns {{ reads: string[], writes: string[], execs: string[], execDynamic: boolean } | null}
 */
function scanSedScript(script) {
  const s = String(script);
  /** @type {string[]} */
  const reads = [];
  /** @type {string[]} */
  const writes = [];
  /** @type {string[]} */
  const execs = [];
  let execDynamic = false;
  let i = 0;
  const at = () => s.charAt(i);
  const skipBlank = () => {
    while (i < s.length && (at() === ' ' || at() === '\t')) i++;
  };
  const toEol = () => {
    const nl = s.indexOf('\n', i);
    const end = nl === -1 ? s.length : nl;
    const text = s.slice(i, end);
    i = end;
    return text.trim();
  };
  /** @param {string} delim */
  const readDelimited = (delim) => {
    while (i < s.length) {
      const c = at();
      if (c === '\\') {
        i += 2;
        continue;
      }
      i++;
      if (c === delim) return true;
    }
    return false;
  };
  const readAddress = () => {
    const c = at();
    if (/[0-9]/.test(c)) {
      while (/[0-9~]/.test(at())) i++;
      return true;
    }
    if (c === '$') {
      i++;
      return true;
    }
    if (c === '/' || c === '\\') {
      const delim = c === '/' ? '/' : s.charAt(i + 1);
      i += c === '/' ? 1 : 2;
      if (!readDelimited(delim)) return null;
      while (/[IM]/.test(at())) i++;
      return true;
    }
    return false;
  };
  while (i < s.length) {
    skipBlank();
    const c0 = at();
    if (c0 === '') break;
    if (c0 === '\n' || c0 === ';' || c0 === '}' || c0 === '{') {
      i++;
      continue;
    }
    if (c0 === '#') {
      toEol();
      continue;
    }
    const first = readAddress();
    if (first === null) return null;
    skipBlank();
    if (first && at() === ',') {
      i++;
      skipBlank();
      if (at() === '+' || at() === '~') {
        i++;
        while (/[0-9]/.test(at())) i++;
      } else if (readAddress() === null) return null;
    }
    skipBlank();
    while (at() === '!') {
      i++;
      skipBlank();
    }
    const cmd = at();
    i++;
    switch (cmd) {
      case '{':
      case '}':
      case '':
        break;
      case 'r':
      case 'R':
        reads.push(toEol());
        break;
      case 'w':
      case 'W':
        writes.push(toEol());
        break;
      case 'e': {
        const text = toEol();
        if (text) execs.push(text);
        else execDynamic = true;
        break;
      }
      case 'a':
      case 'i':
      case 'c':
        while (i < s.length) {
          const line = toEol();
          if (!line.endsWith('\\')) break;
          i++;
        }
        break;
      case ':':
      case 'b':
      case 't':
      case 'T':
      case 'v':
        while (i < s.length && at() !== ';' && at() !== '\n') i++;
        break;
      case 's': {
        const delim = at();
        i++;
        if (!delim || !readDelimited(delim) || !readDelimited(delim)) return null;
        while (i < s.length && !/[\n;}]/.test(at())) {
          const flag = at();
          if (flag === 'w') {
            i++;
            writes.push(toEol());
            break;
          }
          if (flag === 'e') execDynamic = true;
          i++;
        }
        break;
      }
      case 'y': {
        const delim = at();
        i++;
        if (!delim || !readDelimited(delim) || !readDelimited(delim)) return null;
        break;
      }
      case 'q':
      case 'Q':
      case 'l':
      case 'L':
        skipBlank();
        while (/[0-9]/.test(at())) i++;
        break;
      default:
        // biome-ignore lint/security/noSecrets: letras de comandos do sed, não um segredo
        if (!'=dDgGhHnNpPxzF'.includes(cmd)) return null;
    }
  }
  return { reads, writes, execs, execDynamic };
}

/**
 * Argumentos de `awk`: programas (texto), arquivos de programa (-f), in-place
 * (`-i inplace`) e arquivos de entrada (sem as atribuições `var=valor`).
 * @param {string[]} args
 */
function parseAwkArgs(args) {
  /** @type {string[]} */
  const programs = [];
  /** @type {string[]} */
  const programFiles = [];
  /** @type {string[]} */
  const positionals = [];
  let inPlace = false;
  let endOfOptions = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? '';
    if (!endOfOptions && a === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      const value = eq >= 0 ? a.slice(eq + 1) : undefined;
      const take = () => value ?? args[++k] ?? '';
      if (name === '--include') {
        if (/^inplace(?:\.awk)?$/.test(take())) inPlace = true;
      } else if (name === '--source') programs.push(take());
      else if (name === '--file' || name === '--exec') programFiles.push(take());
      else if (['--field-separator', '--assign', '--load'].includes(name)) take();
      continue;
    }
    if (!endOfOptions && a.startsWith('-') && a !== '-') {
      const flag = a.charAt(1);
      const attached = a.slice(2);
      const value = () => (attached !== '' ? attached : (args[++k] ?? ''));
      if (flag === 'i') {
        if (/^inplace(?:\.awk)?$/.test(value())) inPlace = true;
      } else if (flag === 'e') programs.push(value());
      else if (flag === 'f' || flag === 'E') programFiles.push(value());
      else if (flag === 'F' || flag === 'v' || flag === 'l') value();
      continue;
    }
    positionals.push(a);
  }
  if (programs.length === 0 && programFiles.length === 0 && positionals.length > 0) {
    programs.push(positionals.shift() ?? '');
  }
  return {
    programs,
    programFiles,
    inPlace,
    files: positionals.filter((p) => !/^[A-Za-z_]\w*=/.test(p)),
  };
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {Verdict} v
 * @param {PolicyContext} ctx
 */
function checkSecretMentions(bin, args, dynamic, v, ctx) {
  const nameOnly = SECRET_NAME_ONLY_BINS.has(bin);
  // Depois de `cd /proc/self`, um argumento relativo (`cat env*`) aponta para o environ do
  // processo; junta o caminho relativo aos cwds que estão em /proc para classificar.
  const procCwds = cwdCandidates(ctx).filter((c) => /(^|\/)proc(\/|$)/.test(c));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    /** @type {string[]} */
    let values = [arg];
    if (dynamic[i] || /[$`]/.test(arg)) {
      // `cat $(echo .env)`, `cat $(find . -name '.env*')`: o corpo cita o segredo.
      if (!nameOnly && findSubstitutions(arg).subs.some((s) => scriptMentionsSecret(s, ctx))) {
        v.deny(
          `Acesso a segredo por substituição de comando (${arg}) bloqueado. Segredos ficam fora do alcance do agente.`,
        );
        return;
      }
      const expanded = expandWord(arg, ctx.vars);
      values = [...new Set([arg, ...expanded.values])];
      const literalName = !maskExpansions(arg).split('/').at(-1)?.includes('\u0000');
      if (expanded.unresolved && !literalName && CONTENT_DUMPERS.has(bin) && arg !== '{xargs}') {
        v.ask(
          `${bin} com caminho dinâmico (${arg}) que não dá para resolver; confirme que não é um segredo.`,
        );
      }
    }
    for (const value of values) {
      /** @type {string[]} */
      const extra = [];
      if (procCwds.length > 0 && !path.isAbsolute(value) && !value.startsWith('~')) {
        for (const base of procCwds) extra.push(path.posix.join(base, value));
      }
      for (const candidate of [...pathCandidates(value), ...extra]) {
        const secret = classifySecretPath(candidate);
        if (!secret) continue;
        if (secret.kind === 'file' && nameOnly) continue;
        v.deny(
          `Acesso a ${secret.reason} bloqueado. Use .env.example como referência; segredos ficam fora do alcance do agente.`,
        );
        return;
      }
      if (CONTENT_READERS.has(bin) && dotGlobReachesSecret(value)) {
        v.deny(
          `O glob ${value} inclui .env e outros arquivos de segredo; liste os arquivos que precisa ler.`,
        );
        return;
      }
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
  for (const k of exclusionArgumentIndexes(bin, args)) handled.add(k);
  if (!secretMentionsAllowed(bin, args)) {
    const keep = args.map((_a, k) => !handled.has(k));
    checkSecretMentions(
      bin,
      args.filter((_a, k) => keep[k]),
      dynamic.filter((_d, k) => keep[k]),
      v,
      ctx,
    );
  }

  for (const target of writeTargets(bin, args, ctx)) checkWriteTarget(target, ctx, v, bin);
  if (!KNOWN_FILE_BINS.has(bin) && !isReadOnlyLinter(bin, args)) {
    checkUnknownWriter(bin, args, dynamic, ctx, v);
  }

  if (OUTPUT_BINS.has(bin) || bin === 'cat') {
    const texts = OUTPUT_BINS.has(bin) ? [...args, ...cmd.hereStrings] : cmd.hereStrings;
    for (const text of texts) {
      const leaked = referencedVars(text).find(isSensitiveVarName);
      if (leaked) {
        v.deny(`Não imprima variáveis sensíveis (${leaked}) no terminal/transcript.`);
        break;
      }
      checkIndirectExpansion(text, ctx, v);
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
      checkGit(args, dynamic, cmd, all, ctx, depth, v);
      break;
    case 'printf': {
      const at = args.indexOf('-v');
      const name = at >= 0 ? (args[at + 1] ?? '') : '';
      if (HOOK_SWITCH_VARS.has(name) || HOOK_SKIP_VARS.has(name)) {
        v.deny(`Atribuir ${name} (printf -v) desliga os hooks git; proibido.`);
      }
      break;
    }
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
      checkShellVariableArgs(args, dynamic, ctx, depth, v);
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
      checkShellVariableArgs(args, dynamic, ctx, depth, v);
      break;
    }
    case 'local':
    case 'readonly':
      checkShellVariableArgs(args, dynamic, ctx, depth, v);
      break;
    case 'read':
    case 'mapfile':
    case 'readarray':
      for (const name of readTargetNames(bin, args)) {
        if (HOOK_SWITCH_VARS.has(name) || HOOK_SKIP_VARS.has(name)) {
          v.deny(`Atribuir ${name} (read) desliga os hooks git; proibido.`);
        }
      }
      break;
    case 'sed':
    case 'gsed':
      checkSedScripts(args, ctx, depth, v);
      break;
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk':
      checkAwkPrograms(args, ctx, depth, v);
      break;
    case 'jq':
    case 'gojq':
    case 'jaq':
    case 'yq':
      checkJqFilter(args, v);
      break;
    case 'vim':
    case 'vi':
    case 'nvim':
    case 'view':
    case 'gvim':
    case 'ex':
      checkEditor(bin, args, ctx, depth, v);
      break;
    case 'patch':
    case 'gpatch':
      checkPatch(args, ctx, v);
      break;
    case 'playwright':
      if (args[0] === 'cli') checkPlaywrightCli(args.slice(1), v);
      break;
    case 'playwright-cli':
      checkPlaywrightCli(args, v);
      break;
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'zgrep':
    case 'rg':
    case 'ag':
      checkRecursiveReader(bin, args, ctx, v);
      break;
    case 'tar':
    case 'rsync':
      for (const command of embeddedCommands(bin, args)) {
        analyzeScript(command, ctx, depth + 1, v);
        v.ask(`${bin} executa o comando "${command.slice(0, 80)}"; confirme.`);
      }
      // `tar c ... -` (arquivo para stdout) de um diretório com segredos, geralmente num pipe
      // para outro `tar -O`: pode despejar .env*. Pede confirmação.
      if (bin === 'tar' && tarStreamsSecretDir(args, ctx)) {
        v.ask('tar empacotando para a saída um diretório que contém segredos (.env*); confirme.');
      }
      break;
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
 * Comandos que `tar` e `rsync` executam por opção (`--checkpoint-action=exec=`,
 * `--to-command`, `-I`, `rsync -e`...).
 * @param {string} bin
 * @param {string[]} args
 * @returns {string[]}
 */
function embeddedCommands(bin, args) {
  const longOpts =
    bin === 'tar'
      ? [
          '--to-command',
          '--use-compress-program',
          '--info-script',
          '--new-volume-script',
          '--rsh-command',
        ]
      : ['--rsh', '--rsync-path'];
  const shortOpts = bin === 'tar' ? ['-I', '-F'] : ['-e'];
  /** @type {string[]} */
  const out = [];
  args.forEach((a, k) => {
    const action = /^--checkpoint-action=(?:exec|shell)=(.*)$/.exec(a);
    if (bin === 'tar' && action) out.push(action[1] ?? '');
    const long = longOpts.find((o) => a === o || a.startsWith(`${o}=`));
    if (long) out.push(a === long ? (args[k + 1] ?? '') : a.slice(long.length + 1));
    if (shortOpts.includes(a)) out.push(args[k + 1] ?? '');
  });
  return out.filter((c) => c !== '');
}

/**
 * Filtros de exclusão (`grep --exclude='.env*'`, `rg -g '!.env*'`) não leem o arquivo.
 * @param {string} bin
 * @param {string[]} args
 * @returns {number[]}
 */
function exclusionArgumentIndexes(bin, args) {
  if (!['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag'].includes(bin)) return [];
  /** @type {number[]} */
  const out = [];
  args.forEach((a, k) => {
    if (/^--exclude(?:-dir)?=/.test(a) || /^--(?:i?glob|iglob)=!/.test(a)) out.push(k);
    if ((a === '--exclude' || a === '--exclude-dir') && args[k + 1] !== undefined) out.push(k + 1);
    if ((a === '-g' || a === '--glob' || a === '--iglob') && (args[k + 1] ?? '').startsWith('!')) {
      out.push(k + 1);
    }
  });
  return out;
}

/** Diretórios que a varredura em busca de segredo ignora (artefatos, VCS). */
const WALK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
  '.vercel',
  '.output',
]);

/**
 * Varredura limitada (profundidade e diretórios de artefato pulados) em busca de um arquivo
 * de segredo (.env*, chave, credencial) dentro de `absDir`. Para no primeiro achado.
 * @param {string} absDir
 * @param {number} [depth]
 * @returns {boolean}
 */
function treeHasSecretFile(absDir, depth = 0) {
  if (depth > 4) return false;
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!e.isDirectory() && classifySecretPath(e.name)?.kind === 'file') return true;
  }
  for (const e of entries) {
    if (e.isDirectory() && !WALK_SKIP_DIRS.has(e.name) && !e.name.startsWith('.env')) {
      if (treeHasSecretFile(path.join(absDir, e.name), depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Os argumentos de exclusão já tiram os segredos do resultado (`--exclude=.env*`, `-g '!.env*'`).
 * @param {string[]} args
 * @returns {boolean}
 */
function readerExcludesSecrets(args) {
  /** @param {string} p */
  const coversEnv = (p) => /^\.env/.test(p) || p === '.*';
  return args.some((a, k) => {
    if (/^--exclude(?:-dir)?=/.test(a)) return coversEnv(a.slice(a.indexOf('=') + 1));
    if (/^--i?glob=!/.test(a)) return coversEnv(a.slice(a.indexOf('=') + 2));
    if ((a === '--exclude' || a === '--exclude-dir') && args[k + 1] !== undefined) {
      return coversEnv(args[k + 1] ?? '');
    }
    if ((a === '-g' || a === '--glob' || a === '--iglob') && (args[k + 1] ?? '').startsWith('!')) {
      return coversEnv((args[k + 1] ?? '').slice(1));
    }
    return false;
  });
}

/**
 * Operandos de caminho (diretórios/arquivos de busca) de um grep/rg/ag, sem o padrão.
 * @param {string} bin
 * @param {string[]} args
 * @returns {string[]}
 */
function readerSearchRoots(bin, args) {
  const grepLike = ['grep', 'egrep', 'fgrep', 'zgrep'].includes(bin);
  const hasExprOpt = args.some(
    (a) =>
      a === '-e' ||
      a === '-f' ||
      a === '--regexp' ||
      a === '--expression' ||
      a === '--file' ||
      /^--(?:regexp|expression|file)=/.test(a),
  );
  /** @type {Record<string, number>} */
  const consumes = {};
  if (grepLike) {
    for (const o of ['-A', '-B', '-C', '-m', '-d', '-D']) consumes[o] = 1;
  }
  for (const o of ['-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-M']) {
    consumes[o] = 1;
  }
  /** @type {string[]} */
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') {
      for (let j = i + 1; j < args.length; j++) positionals.push(args[j] ?? '');
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      i += consumes[a] ?? 0;
      continue;
    }
    positionals.push(a);
  }
  const roots = hasExprOpt ? positionals : positionals.slice(1);
  return roots.length > 0 ? roots : ['.'];
}

/**
 * rg/ag estão lendo arquivos ocultos/ignorados (onde o .env costuma estar).
 * @param {string} bin
 * @param {string[]} args
 * @returns {boolean}
 */
function readerIsUnrestricted(bin, args) {
  if (bin === 'rg') {
    const uCount = args
      .filter((a) => /^-[A-Za-z]*u/.test(a) && !a.startsWith('--'))
      .reduce((n, a) => n + (a.match(/u/g)?.length ?? 0), 0);
    if (uCount >= 2) return true;
    return args.some((a) => /^--(?:no-ignore(?:-vcs|-dot|-parent|-global)?|unrestricted)$/.test(a));
  }
  if (bin === 'ag')
    return args.some((a) => a === '-u' || a === '--unrestricted' || a === '--hidden');
  return false;
}

/**
 * Leitor recursivo (`grep -r`, `rg -uu`, `ag -u`) sobre diretórios que contêm arquivos de
 * segredo: pede confirmação (o resultado pode despejar .env*, chaves...).
 * @param {string} bin
 * @param {string[]} args
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkRecursiveReader(bin, args, ctx, v) {
  const grepLike = ['grep', 'egrep', 'fgrep', 'zgrep'].includes(bin);
  const recursive = grepLike
    ? args.some(
        (a) =>
          a === '-r' ||
          a === '-R' ||
          a === '--recursive' ||
          a === '--dereference-recursive' ||
          (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)) ||
          a === '--directories=recurse',
      )
    : readerIsUnrestricted(bin, args);
  if (!recursive) return;
  if (readerExcludesSecrets(args)) return;
  for (const root of readerSearchRoots(bin, args)) {
    if (/[$`*?[]/.test(root)) continue;
    const abs = path.isAbsolute(root) ? root : path.resolve(ctx.cwd, root);
    if (treeHasSecretFile(abs)) {
      v.ask(
        `${bin} recursivo em ${root} que contém arquivos de segredo (.env*, chaves); exclua-os (--exclude=.env*) ou confirme que não serão lidos.`,
      );
      return;
    }
  }
}

/**
 * `tar c ... -` (ou sem `-f`): empacota para a saída um diretório que contém segredos.
 * @param {string[]} args
 * @param {PolicyContext} ctx
 * @returns {boolean}
 */
function tarStreamsSecretDir(args, ctx) {
  const create =
    args.some((a) => a === '--create' || (/^-[A-Za-z]/.test(a) && a.includes('c'))) ||
    /^[A-Za-wyz]*c[A-Za-z]*$/.test(args[0] ?? '');
  if (!create) return false;
  const toStdout =
    args.includes('-') ||
    args.some((a) => a === '--file=-' || a === '--to-stdout' || a === '-O') ||
    args.some((a, k) => (a === '-f' || a === '--file') && args[k + 1] === '-') ||
    !args.some((a) => a === '-f' || a === '--file' || /^-[A-Za-z]*f/.test(a) || /^--file=/.test(a));
  if (!toStdout) return false;
  for (const a of args) {
    if (a.startsWith('-') || a === '') continue;
    if (/[$`*?[]/.test(a)) continue;
    const abs = path.isAbsolute(a) ? a : path.resolve(ctx.cwd, a);
    if (treeHasSecretFile(abs)) return true;
  }
  return false;
}

/** Opções longas do GNU patch 2.7 (para resolver abreviações por prefixo único). */
const PATCH_LONG_OPTIONS = [
  '--backup',
  '--backup-if-mismatch',
  '--basename-prefix',
  '--batch',
  '--binary',
  '--context',
  '--debug',
  '--directory',
  '--dry-run',
  '--ed',
  '--follow-symlinks',
  '--force',
  '--forward',
  '--fuzz',
  '--get',
  '--help',
  '--ifdef',
  '--ignore-whitespace',
  '--input',
  '--merge',
  '--no-backup-if-mismatch',
  '--normal',
  '--output',
  '--posix',
  '--prefix',
  '--quiet',
  '--quoting-style',
  '--read-only',
  '--reject-file',
  '--reject-format',
  '--remove-empty-files',
  '--reverse',
  '--set-time',
  '--set-utc',
  '--silent',
  '--strip',
  '--suffix',
  '--unified',
  '--verbose',
  '--version',
  '--version-control',
];
/** Opções longas do patch com valor obrigatório (`--directory DIR` ou `--directory=DIR`). */
const PATCH_LONG_VALUE = new Set([
  '--basename-prefix',
  '--debug',
  '--directory',
  '--fuzz',
  '--get',
  '--ifdef',
  '--input',
  '--output',
  '--prefix',
  '--quoting-style',
  '--read-only',
  '--reject-file',
  '--reject-format',
  '--strip',
  '--suffix',
  '--version-control',
]);
/** Letras do patch que levam valor (colado, `-d.claude`, `-p1`, ou no argumento seguinte). */
const PATCH_SHORT_VALUE = /^[BDFVYdgioprxz]$/;

/**
 * Argumentos de `patch [opções] [original [patchfile]]`: diretório (`-d`), saída (`-o`),
 * arquivo de rejeitos (`-r`), operandos e se só simula (`--dry-run`) ou só informa
 * (`--help`, `--version`, `-v`).
 * @param {string[]} args
 */
function parsePatchArgs(args) {
  const out = {
    /** @type {string | null} */ dir: null,
    /** @type {string | null} */ output: null,
    /** @type {string | null} */ reject: null,
    /** @type {string[]} */ operands: [],
    dryRun: false,
    info: false,
  };
  /**
   * @param {string} opt
   * @param {string} value
   */
  const set = (opt, value) => {
    if (opt === 'd' || opt === '--directory') out.dir = value;
    else if (opt === 'o' || opt === '--output') out.output = value;
    else if (opt === 'r' || opt === '--reject-file') out.reject = value;
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? '';
    if (a === '--') {
      out.operands.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const typed = eq >= 0 ? a.slice(0, eq) : a;
      const hits = PATCH_LONG_OPTIONS.filter((o) => o.startsWith(typed));
      const name = hits.includes(typed) ? typed : hits.length === 1 ? (hits[0] ?? null) : null;
      if (name === '--dry-run') out.dryRun = true;
      if (name === '--help' || name === '--version') out.info = true;
      if (name !== null && PATCH_LONG_VALUE.has(name)) {
        set(name, eq >= 0 ? a.slice(eq + 1) : (args[k + 1] ?? ''));
        if (eq < 0) k++;
      }
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      for (let c = 1; c < a.length; c++) {
        const ch = a.charAt(c);
        if (ch === 'v') out.info = true;
        if (PATCH_SHORT_VALUE.test(ch)) {
          const rest = a.slice(c + 1);
          set(ch, rest !== '' ? rest : (args[k + 1] ?? ''));
          if (rest === '') k++;
          break;
        }
      }
      continue;
    }
    out.operands.push(a);
  }
  return out;
}

/**
 * Onde o `patch` aplica o diff (`-d DIR` resolvido contra os cwds possíveis): `deny` quando
 * é `.claude/hooks/` ou subpasta (todo arquivo do diff cai na configuração protegida; o GNU
 * patch recusa nomes com `..`), `claude` quando é outra parte de `.claude/`.
 * @param {string} dir
 * @param {PolicyContext} ctx
 * @returns {'deny' | 'claude' | null}
 */
function patchDirLevel(dir, ctx) {
  if (/[$`*?[{]/.test(dir)) return null;
  const expanded = dir.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
  const bases = path.isAbsolute(expanded) ? [''] : cwdCandidates(ctx);
  /** @type {'claude' | null} */
  let level = null;
  for (const base of bases) {
    const abs = path.resolve(base || '/', expanded);
    const rel = path.relative(ctx.projectDir, abs).split(path.sep).join('/');
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (protectedConfigLevel(rel) === 'deny') return 'deny';
    if (rel === '.claude' || rel.startsWith('.claude/')) level = 'claude';
  }
  return level;
}

/**
 * `patch`: os alvos estão nos cabeçalhos do diff, que o guarda não lê; pede confirmação
 * sempre, como `git apply` (exceto `--dry-run`, `--help`, `--version`). Nega quando dá para
 * provar que escreve na configuração protegida: arquivo nomeado (`patch .claude/settings.json`),
 * saída `-o`, rejeitos `-r`, ou diretório (`-d`/cwd) dentro de `.claude/hooks/`.
 * @param {string[]} args
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkPatch(args, ctx, v) {
  const p = parsePatchArgs(args);
  if (p.info || p.dryRun) return;
  const dir = p.dir ?? '.';
  /** @param {string} f */
  const inDir = (f) => (path.isAbsolute(f) || f.startsWith('~') ? f : path.posix.join(dir, f));
  const original = p.operands[0];
  // Com `-o`, o original só é lido; a escrita vai para a saída.
  for (const f of [p.output ?? original, p.reject]) {
    if (f !== undefined && f !== null && f !== '' && f !== '-')
      checkWriteTarget(inDir(f), ctx, v, 'patch');
  }
  if (p.output === null && original === undefined) {
    const level = patchDirLevel(dir, ctx);
    if (level === 'deny') {
      v.deny(
        `patch aplicado dentro de .claude/hooks/ (${dir}): todo arquivo do diff é configuração protegida do agente. Use a ferramenta Edit: o guard-files pede confirmação humana.`,
      );
    } else if (level === 'claude') {
      v.ask(
        'patch aplicado dentro de .claude/: o diff pode alterar settings e hooks do agente; confirme.',
      );
    }
  }
  v.ask('patch altera os arquivos citados no diff, que o guard-bash não lê; confirme.');
}

/**
 * Linters e formatadores só escrevem com --write/--fix.
 * @param {string} bin
 * @param {string[]} args
 */
function isReadOnlyLinter(bin, args) {
  if (!['biome', 'eslint', 'prettier', 'tsc', 'vitest', 'turbo', 'knip'].includes(bin))
    return false;
  return !args.some((a) => /^(?:--write|--fix|--apply|--apply-unsafe|-w|--unsafe)(?:=|$)/.test(a));
}

/**
 * Programa desconhecido (ou linter com --write) citando a configuração protegida do agente:
 * pode reescrevê-la sem passar pelas regras de escrita (`patch`, `sponge`, `sort -o`...).
 * @param {string} bin
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkUnknownWriter(bin, args, dynamic, ctx, v) {
  for (let k = 0; k < args.length; k++) {
    if (dynamic[k]) continue;
    for (const candidate of pathCandidates(args[k] ?? '')) {
      if (candidate.startsWith('-')) continue;
      const expanded = candidate.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
      const bases = path.isAbsolute(expanded) ? [''] : cwdCandidates(ctx);
      for (const base of bases) {
        const rel = path
          .relative(ctx.projectDir, path.resolve(base || '/', expanded))
          .split(path.sep)
          .join('/');
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        if (protectedConfigLevel(rel) === 'deny') {
          v.ask(
            `${bin} cita ${rel} (configuração protegida do agente) e o guard-bash não sabe se ele escreve no arquivo; confirme.`,
          );
          return;
        }
      }
    }
  }
}

/**
 * `export`/`declare`/`local`/`readonly`: atribuições e nomes de variáveis de hook.
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkShellVariableArgs(args, dynamic, ctx, depth, v) {
  args.forEach((a, k) => {
    if (isAssignment(a)) {
      checkAssignment(a, dynamic[k] ?? false, ctx, depth, v);
      return;
    }
    if (HOOK_SKIP_VARS.has(a) || HOOK_SWITCH_VARS.has(a)) {
      v.deny(
        `Exportar/declarar ${a} serve para desligar os hooks git; proibido. Corrija a causa da falha.`,
      );
    }
  });
}

/**
 * `sed`: comandos `r`/`R` (lê arquivo), `w`/`W` (escreve) e `e` (executa) dentro do script.
 * @param {string[]} args
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkSedScripts(args, ctx, depth, v) {
  const parsed = parseSedArgs(args);
  for (const script of parsed.scripts) {
    const scan = scanSedScript(script);
    if (scan === null) {
      if (/(?:^|[;\n}\d$/])\s*[rRwWe]\s+\S/.test(script)) {
        v.ask(
          'Script sed que o guard-bash não conseguiu analisar e pode ler/escrever arquivos; confirme.',
        );
      }
      continue;
    }
    checkSecretMentions(
      'cat',
      scan.reads,
      scan.reads.map(() => false),
      v,
      ctx,
    );
    for (const file of scan.writes) {
      checkSecretMentions('cat', [file], [false], v, ctx);
      checkWriteTarget(file, ctx, v, 'sed w');
    }
    for (const command of scan.execs) analyzeScript(command, ctx, depth + 1, v);
    if (scan.execs.length > 0 || scan.execDynamic) {
      v.ask('sed com o comando "e" executa comandos de shell; confirme.');
    }
  }
}

/**
 * `awk`: ENVIRON, `getline < "arquivo"`, `print > "arquivo"`, `system()` e pipes.
 * @param {string[]} args
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkAwkPrograms(args, ctx, depth, v) {
  const parsed = parseAwkArgs(args);
  if (parsed.programFiles.length > 0) {
    v.ask('Programa awk em arquivo (-f) não é analisado pelo guard-bash; confirme.');
  }
  for (const program of parsed.programs) {
    for (const m of program.matchAll(/\bENVIRON\b(\s*\[\s*"([^"]*)"\s*\])?/g)) {
      const name = m[2];
      if (name === undefined) {
        v.deny('Despejar o ambiente inteiro (awk ENVIRON) expõe segredos.');
        break;
      }
      if (isSensitiveVarName(name))
        v.deny(`Acesso a variável sensível (${name}) em awk bloqueado.`);
    }
    const literals = [...program.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1] ?? '');
    if (/\bgetline\b/.test(program)) {
      checkSecretMentions(
        'cat',
        literals,
        literals.map(() => false),
        v,
        ctx,
      );
    }
    for (const m of program.matchAll(/\bprintf?\b[^;{}\n]*?(>>?|\|)\s*"((?:[^"\\\n]|\\.)*)"/g)) {
      const target = m[2] ?? '';
      if (m[1] === '|') {
        analyzeScript(target, ctx, depth + 1, v);
        v.ask('awk enviando saída para um comando (print | "cmd"); confirme.');
      } else {
        checkSecretMentions('cat', [target], [false], v, ctx);
        checkWriteTarget(target, ctx, v, 'awk print >');
      }
    }
    for (const m of program.matchAll(/"((?:[^"\\\n]|\\.)*)"\s*\|\s*getline/g)) {
      analyzeScript(m[1] ?? '', ctx, depth + 1, v);
      v.ask('awk executando comando ("cmd" | getline); confirme.');
    }
    if (/\bsystem\s*\(/.test(program)) {
      for (const m of program.matchAll(/\bsystem\s*\(\s*"((?:[^"\\\n]|\\.)*)"\s*\)/g)) {
        analyzeScript(m[1] ?? '', ctx, depth + 1, v);
      }
      v.ask('awk system() executa comandos de shell; confirme.');
    }
  }
}

/**
 * `jq`/`yq`: `env` e `$ENV` sem nome despejam o ambiente; com nome sensível, também negam.
 * @param {string[]} args
 * @param {Verdict} v
 */
function checkJqFilter(args, v) {
  const consumes = {
    '--arg': 2,
    '--argjson': 2,
    '--slurpfile': 2,
    '--rawfile': 2,
    '--indent': 1,
    '-L': 1,
  };
  let filter = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? '';
    if (a === '-f' || a === '--from-file') return;
    if (a.startsWith('-') && a !== '-') {
      k += /** @type {Record<string, number>} */ (consumes)[a] ?? 0;
      continue;
    }
    filter = a;
    break;
  }
  if (filter === null) return;
  const re =
    /(^|[^\w.$"])(\$ENV|(?:str)?env)\b(?!\s*:)(\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*"([^"]+)"\s*\]|\(\s*([A-Za-z_]\w*)\s*\)))?/g;
  for (const m of filter.matchAll(re)) {
    const name = m[4] ?? m[5] ?? m[6];
    if (name === undefined) {
      v.deny('Despejar o ambiente inteiro (jq env / $ENV) expõe segredos.');
      return;
    }
    if (isSensitiveVarName(name)) {
      v.deny(`Acesso a variável sensível (${name}) via jq bloqueado.`);
      return;
    }
  }
}

/**
 * `playwright cli`: subcomandos que executam código no processo do Playwright (RCE
 * equivalente), leem/gravam sessão ou arquivos pedem confirmação; anexar a um navegador
 * pessoal (perfil, CDP, extensão) é negado.
 * @param {string[]} args
 * @param {Verdict} v
 */
function checkPlaywrightCli(args, v) {
  const sub = args.find((a) => !a.startsWith('-'));
  const flags = args.filter((a) => a.startsWith('-')).map((a) => a.split('=')[0]);
  if (
    sub === 'attach' ||
    flags.some(
      (f) => f === '--profile' || f === '--persistent' || f === '--cdp' || f === '--extension',
    )
  ) {
    v.deny(
      'playwright cli conectado a navegador/perfil pessoal (attach, --profile, --persistent, --cdp, --extension) é proibido: use sessão isolada.',
    );
    return;
  }
  if (
    /^(?:run-code|eval|state-save|state-load|route|upload|install|install-browser|cookie-.+|localstorage-.+|sessionstorage-.+)$/.test(
      sub ?? '',
    )
  ) {
    v.ask(
      `playwright cli ${sub} executa código no processo do Playwright ou lê/grava sessão e arquivos; confirme.`,
    );
  }
  if (flags.some((f) => f === '--filename' || f === '--config')) {
    v.ask('playwright cli com --filename/--config lê ou grava arquivo arbitrário; confirme.');
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
    consumes['-i'] = 1;
    consumes['-l'] = 1;
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
    const relative = !target.value.startsWith('/') && !target.value.startsWith('~');
    const contexts = relative ? cwdCandidates(ctx).map((cwd) => ({ ...ctx, cwd })) : [ctx];
    if (contexts.some((c) => isDangerousDeleteTarget(target.value, c))) {
      v.deny(`rm recursivo em alvo perigoso (${target.value}).`);
    } else if (relative && ctx.cwdUnknown) {
      v.ask(`rm recursivo de ${target.value} depois de cd para destino desconhecido; confirme.`);
    } else if (!contexts.every((c) => isSafeDeleteTarget(target.value, c))) {
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
    // `find <dir com segredos> -exec <leitor> {} +`: o leitor despeja o conteúdo dos .env*
    // que a varredura encontrar. Pede confirmação.
    const prog = canonicalInterpreter(path.posix.basename(inner[0] ?? ''));
    const isReader = CONTENT_DUMPERS.has(prog) || !KNOWN_FILE_BINS.has(prog);
    if (
      isReader &&
      roots.some((r) => !/[$`*?[]/.test(r) && treeHasSecretFile(path.resolve(ctx.cwd, r)))
    ) {
      v.ask(
        `find -exec ${prog} sobre diretório que contém segredos (.env*, chaves); confirme que não serão lidos.`,
      );
    }
    // `find .claude -exec <escritor> {} \;`: o escritor roda em cada arquivo achado, podendo
    // sobrescrever a configuração protegida do agente (o `{}` é o caminho casado, invisível aqui).
    const protectedRoot = roots.some((r) => {
      if (/[$`]/.test(r)) return true;
      const abs = path.resolve(ctx.cwd, r);
      const rel = path.relative(ctx.projectDir, abs).split(path.sep).join('/');
      return rel === '' || rel === '.' || /^(?:\.claude|\.git|\.husky|\.config)(?:\/|$)/.test(rel);
    });
    // biome-ignore format: lista curta de mutadores, uma linha
    const mutators = ['rm','rmdir','unlink','tee','truncate','shred','dd','sed','gsed','perl','ruby','awk','gawk'];
    const isWriter =
      TREE_WRITERS.has(prog) || mutators.includes(prog) || !KNOWN_FILE_BINS.has(prog);
    if (protectedRoot && isWriter && inner.some((w) => w.includes('{}'))) {
      v.ask(
        `find -exec ${prog} sobre diretório protegido (${roots.join(' ')}) pode sobrescrever a configuração do agente; confirme.`,
      );
    }
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

/** Maior padrão de refspec com curinga avaliado; acima disso conta como "pode casar". */
const MAX_REFSPEC_GLOB_LENGTH = 1024;

/**
 * Um padrão de destino de refspec com `*` pode casar main/master (`refs/heads/*`, `ma*`, `m*`)?
 * `*` é qualquer sequência e `?` um caractere qualquer (o git recusa `?` em ref, então o push
 * falha de qualquer jeito). Sequências de `*`/`?` são colapsadas antes de virar expressão
 * regular: `.*.*.*` (ou `.*?.*?`) repetido levava segundos de backtracking. Padrão longo
 * demais não é avaliado e conta como "pode casar" (fail-closed).
 * @param {string} pat
 * @returns {boolean}
 */
function globRefMatchesProtected(pat) {
  if (pat.length > MAX_REFSPEC_GLOB_LENGTH) return true;
  /** @param {string} p */
  const toRe = (p) => {
    let src = '';
    for (const ch of collapseWildcards(p)) {
      if (ch === '*') src += '.*';
      else if (ch === '?') src += '.';
      else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${src}$`);
  };
  const re = toRe(pat);
  if (['refs/heads/main', 'refs/heads/master', 'main', 'master'].some((c) => re.test(c))) {
    return true;
  }
  if (!pat.startsWith('refs/')) {
    const re2 = toRe(`refs/heads/${pat}`);
    if (['refs/heads/main', 'refs/heads/master'].some((c) => re2.test(c))) return true;
  }
  return false;
}

/**
 * @param {string} ref
 */
function normalizeBranchRef(ref) {
  return ref.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
}

/**
 * @typedef {object} GitConfigEntry
 * @property {string} key
 * @property {string | null} value `null` quando vem do ambiente (`--config-env`)
 * @property {string} source de onde veio (`-c`, `--config-env`, `env`, `config`)
 */

/**
 * Entradas de configuração passadas por ambiente (GIT_CONFIG_COUNT/KEY_n/VALUE_n e
 * GIT_CONFIG_PARAMETERS) atribuídas no próprio script.
 * @param {Vars | undefined} vars
 * @returns {GitConfigEntry[]}
 */
function gitConfigFromEnv(vars) {
  /** @type {GitConfigEntry[]} */
  const out = [];
  if (!vars) return out;
  for (const [name, keys] of vars) {
    const m = /^GIT_CONFIG_KEY_(\d+)$/.exec(name);
    if (!m) continue;
    const values = vars.get(`GIT_CONFIG_VALUE_${m[1]}`);
    for (const key of keys ?? ['']) {
      for (const value of values ?? [null]) out.push({ key, value, source: 'env' });
    }
  }
  for (const params of vars.get('GIT_CONFIG_PARAMETERS') ?? []) {
    for (const c of parseShell(params).commands) {
      for (const word of c.words) {
        const eq = word.indexOf('=');
        out.push({
          key: eq >= 0 ? word.slice(0, eq) : word,
          value: eq >= 0 ? word.slice(eq + 1) : 'true',
          source: 'env',
        });
      }
    }
  }
  return out;
}

/** @param {string} key */
function isPushConfigKey(key) {
  return /^(?:remote\.[^.]+\.(?:push|mirror)|remote\.pushdefault|push\.default|branch\..+\.(?:merge|pushremote|remote))$/i.test(
    key,
  );
}

/** @param {string} value */
function isTruthy(value) {
  return /^(?:true|yes|on|1|)$/i.test(value.trim());
}

/**
 * Comando que o git executará por causa de uma configuração (`-c core.fsmonitor=...`,
 * `GIT_SSH_COMMAND=...`, `git config core.sshCommand ...`): analisa o comando e pede
 * confirmação, salvo valores inofensivos (`core.pager=cat`, `GIT_EDITOR=true`).
 * @param {string} key chave canônica em minúsculas
 * @param {string} label como aparece para o usuário
 * @param {string | null} value `null` = dinâmico/vindo do ambiente
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkGitExecValue(key, label, value, ctx, depth, v) {
  if (value === null) {
    v.ask(`${label} define um comando que o git executa, com valor dinâmico; confirme.`);
    return;
  }
  const trimmed = value.trim();
  if (key === 'core.fsmonitor' && /^(?:true|false|yes|no|on|off|1|0|)$/i.test(trimmed)) return;
  if (
    /^(?:core\.(?:pager|editor)|sequence\.editor|pager\..+|interactive\.difffilter)$/.test(key) &&
    SAFE_PAGER_EDITOR.test(trimmed)
  ) {
    return;
  }
  if (/^protocol\./.test(key)) {
    // `never`/`false`/`0` restringe transportes: não há perigo. `always`/`user` (ou dinâmico,
    // já tratado acima) habilitam ext::, que executa comando.
    if (/^(?:always|user)$/i.test(trimmed)) {
      v.ask(`${label} habilita um transporte que executa comando (ext::); confirme.`);
    }
    return;
  }
  if (key.startsWith('alias.')) {
    if (trimmed.startsWith('!')) analyzeScript(trimmed.slice(1), ctx, depth + 1, v);
    else analyzeScript(`git ${trimmed}`, ctx, depth + 1, v);
  } else {
    analyzeScript(trimmed.replace(/^!/, ''), ctx, depth + 1, v);
  }
  v.ask(`${label} faz o git executar "${trimmed.slice(0, 80)}"; confirme.`);
}

/**
 * Regras para uma entrada de configuração do git, transitória (`-c`, ambiente) ou
 * persistida (`git config chave valor`).
 * @param {GitConfigEntry} entry
 * @param {'transient' | 'persist'} mode
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkGitConfigEntry(entry, mode, ctx, depth, v) {
  const key = entry.key.toLowerCase();
  const label = `${entry.source === 'config' ? 'git config' : `git ${entry.source}`} ${entry.key}`;
  if (key === 'core.hookspath') {
    v.deny(`${label} desliga os hooks do repositório; não contorne verificações.`);
    return;
  }
  if (/^include(?:if\..+)?\.path$/.test(key)) {
    v.deny(
      `${label} inclui outro arquivo de configuração (pode trazer core.hooksPath e desligar os hooks); proibido.`,
    );
    return;
  }
  if (isPushConfigKey(key)) {
    if (mode === 'persist') checkPersistedPushConfig(entry, v);
    return;
  }
  if (GIT_EXEC_KEYS.some((re) => re.test(key))) {
    const value = entry.value !== null && /[$`]/.test(entry.value) ? null : entry.value;
    checkGitExecValue(key, label, value, ctx, depth, v);
  }
}

/**
 * `git config` gravando configuração de push (fica valendo para todo `git push` futuro).
 * @param {GitConfigEntry} entry
 * @param {Verdict} v
 */
function checkPersistedPushConfig(entry, v) {
  const key = entry.key.toLowerCase();
  const value = entry.value ?? '';
  if (/^remote\.[^.]+\.push$/.test(key)) {
    checkRefspec(value, null, v, `git config ${entry.key}`);
  } else if (/^remote\.[^.]+\.mirror$/.test(key) && isTruthy(value)) {
    v.deny(`git config ${entry.key}=true transforma todo push em --mirror; proibido.`);
    return;
  } else if (/^branch\..+\.merge$/.test(key) && isProtectedBranch(normalizeBranchRef(value))) {
    v.ask(
      `git config ${entry.key} aponta para ${value}; confirme (push.default=upstream enviaria para lá).`,
    );
    return;
  }
  v.ask(`git config ${entry.key} muda para onde o git push envia; confirme.`);
}

/**
 * Avalia um refspec de push: `+` força, `:dst` apaga, destino main/master é proibido.
 * @param {string} raw
 * @param {string | null} branch branch atual (para `HEAD`)
 * @param {Verdict} v
 * @param {string} where
 * @param {boolean} [del] `git push --delete`
 * @returns {boolean} se o destino é seguro (não protegido)
 */
function checkRefspec(raw, branch, v, where, del = false) {
  let spec = raw.trim();
  if (/[$`]/.test(spec)) {
    v.ask(`Refspec dinâmico (${raw}) em ${where}; confirme o destino.`);
    return false;
  }
  if (spec.startsWith('+')) {
    v.deny(`Refspec com "+" (${raw}) em ${where} força o push; proibido.`);
    spec = spec.slice(1);
  }
  if (spec.includes('*')) {
    // Curinga (`refs/heads/*:refs/heads/*`, `m*`): pode criar/sobrescrever várias refs remotas.
    const colonG = spec.indexOf(':');
    const dstPat = colonG >= 0 ? spec.slice(colonG + 1) : spec;
    if (globRefMatchesProtected(dstPat)) {
      v.deny(`Refspec curinga (${raw}) em ${where} pode sobrescrever main/master; proibido.`);
    } else {
      v.ask(`Refspec curinga (${raw}) em ${where} pode criar/sobrescrever várias refs; confirme.`);
    }
    return false;
  }
  const colon = spec.indexOf(':');
  if (colon === 0 || del) {
    const target = normalizeBranchRef(colon === 0 ? spec.slice(1) : spec);
    if (isProtectedBranch(target)) v.deny(`Apagar a branch remota ${target} é proibido.`);
    else v.ask(`git push removendo a ref remota ${target}; confirme.`);
    return false;
  }
  let dst = colon > 0 ? spec.slice(colon + 1) : spec;
  if (colon < 0 && (spec === 'HEAD' || spec === '@')) dst = branch ?? spec;
  const name = normalizeBranchRef(dst);
  if (isProtectedBranch(name)) {
    v.deny(
      `Push direto para ${name} é proibido (${where}); abra um PR a partir de uma branch de trabalho.`,
    );
    return false;
  }
  return true;
}

/**
 * `-x CMD`, `--exec CMD`, `--exec=CMD` (e equivalentes) de um subcomando do git.
 * @param {string[]} rest
 * @param {string[]} shortOpts
 * @param {string[]} longOpts
 * @returns {string[]}
 */
function gitCommandOptions(rest, shortOpts, longOpts) {
  /** @type {string[]} */
  const out = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? '';
    if (a === '--') break;
    if (shortOpts.includes(a) || longOpts.includes(a)) {
      if (rest[k + 1] !== undefined) out.push(rest[k + 1] ?? '');
      k++;
      continue;
    }
    const long = longOpts.find((o) => a.startsWith(`${o}=`));
    if (long) {
      out.push(a.slice(long.length + 1));
      continue;
    }
    const short = shortOpts.find(
      (o) => a.startsWith(o) && a.length > o.length && !a.startsWith('--'),
    );
    if (short) out.push(a.slice(short.length));
  }
  return out;
}

/**
 * Opções longas que as regras abaixo tratam como perigosas, por subcomando (`--no-verify`
 * vale para todos).
 * @type {Record<string, string[]>}
 */
const GIT_PROTECTED_OPTIONS = {
  push: [
    '--force',
    '--force-with-lease',
    '--force-if-includes',
    '--delete',
    '--all',
    '--branches',
    '--mirror',
    '--receive-pack',
    '--exec',
  ],
  reset: ['--hard'],
  clean: ['--force'],
  checkout: ['--force'],
  switch: ['--force', '--discard-changes'],
  branch: ['--delete', '--force', '--move', '--copy'],
  add: ['--force'],
};

/**
 * Troca opções longas abreviadas do git pelo nome completo: o parse-options aceita qualquer
 * prefixo único (`--mi` = `--mirror`, `--delet` = `--delete`, `--force-w` =
 * `--force-with-lease`), e as regras abaixo comparam nomes exatos. Prefixo ambíguo que pode
 * ser opção protegida (`--forc`, `--fo`) é recusado: o git também recusaria, e não há motivo
 * legítimo para escrevê-lo assim.
 * @param {string} sub
 * @param {string[]} rest argumentos depois do subcomando
 * @param {Verdict} v
 * @returns {string[]}
 */
function normalizeGitOptions(sub, rest, v) {
  /** @type {string[]} */
  const out = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? '';
    if (a === '--') {
      out.push(...rest.slice(k));
      break;
    }
    const resolved = resolveGitLongOption(sub, a);
    if (resolved === null) {
      // No push, opção fora da tabela pode ser uma opção de um git mais novo (ou abreviação
      // dela) que a regra não conhece: fail-closed.
      if (sub === 'push' && a.startsWith('--') && a !== '--') {
        v.ask(`git push ${a}: opção que o guard-bash não conhece; confirme o que ela faz.`);
      }
      out.push(a);
      continue;
    }
    if ('ambiguous' in resolved) {
      const risky = resolved.ambiguous.filter(
        (name) => name === '--no-verify' || (GIT_PROTECTED_OPTIONS[sub] ?? []).includes(name),
      );
      if (risky.length > 0) {
        const message = `git ${sub} ${a} é abreviação ambígua que pode ser ${risky.join(', ')}; escreva a opção completa.`;
        if (sub === 'push' || risky.includes('--no-verify')) v.deny(message);
        else v.ask(message);
      }
      out.push(a);
      continue;
    }
    out.push(resolved.value === null ? resolved.name : `${resolved.name}=${resolved.value}`);
    // O valor de `--repo origin`, `--exec cmd`... não é opção: passa sem normalizar.
    if (resolved.value === null && gitOptionTakesValue(sub, resolved.name) && k + 1 < rest.length) {
      out.push(rest[k + 1] ?? '');
      k++;
    }
  }
  return out;
}

/**
 * `--no-verify` e qualquer abreviação que o git aceite (`--no-verif`, `--no-veri`...).
 * @param {string} arg
 */
function isNoVerify(arg) {
  const name = arg.split('=')[0] ?? '';
  return name.length >= '--no-v'.length && '--no-verify'.startsWith(name);
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
function checkGit(args, dynamic, cmd, all, ctx, depth, v) {
  let gitCtx = ctx;
  /** @type {GitConfigEntry[]} */
  const configs = [];
  const valueOpts = new Set([
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--super-prefix',
    '--list-cmds',
    '--attr-source',
  ]);
  /** @param {string} text @param {string} source */
  const addConfig = (text, source) => {
    const eq = text.indexOf('=');
    configs.push({
      key: eq >= 0 ? text.slice(0, eq) : text,
      value: source === '--config-env' ? null : eq >= 0 ? text.slice(eq + 1) : 'true',
      source,
    });
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '-C') {
      gitCtx = chdir(gitCtx, args[i + 1] ?? '.', dynamic[i + 1] ?? false);
      i += 2;
      continue;
    }
    if (a === '-c') {
      addConfig(args[i + 1] ?? '', '-c');
      i += 2;
      continue;
    }
    if (a === '--config-env') {
      addConfig(args[i + 1] ?? '', '--config-env');
      i += 2;
      continue;
    }
    if (a.startsWith('--config-env=')) {
      addConfig(a.slice('--config-env='.length), '--config-env');
      i++;
      continue;
    }
    if (a === '--exec-path' || a.startsWith('--exec-path=')) {
      if (a !== '--exec-path' || (args[i + 1] !== undefined && !args[i + 1]?.startsWith('-'))) {
        v.ask('git --exec-path troca os programas que o git executa; confirme.');
      }
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
  configs.push(...gitConfigFromEnv(ctx.vars));
  if (ctx.vars?.has('HOME') || ctx.vars?.has('XDG_CONFIG_HOME')) {
    v.ask(
      'HOME/XDG_CONFIG_HOME trocados para o git: a configuração global passa a vir de outro arquivo (pode desligar os hooks); confirme.',
    );
  }
  for (const entry of configs) checkGitConfigEntry(entry, 'transient', gitCtx, depth, v);
  const sub = args[i];
  if (sub === undefined) return;
  const rest = normalizeGitOptions(sub, args.slice(i + 1), v);
  const restDynamic = dynamic.slice(i + 1);
  if (rest.some(isNoVerify)) {
    v.deny(
      'git --no-verify (inclusive abreviado, como --no-verif) é proibido: não pule hooks nem verificações; corrija a causa da falha.',
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
    checkWriteTarget(target, gitCtx, v, `git ${sub} --output`);
    const abs = path.resolve(gitCtx.cwd, target);
    if (!/^\/(?:tmp|private\/tmp)\//.test(abs) && abs !== '/dev/null') {
      v.ask(`git ${sub} --output grava em ${target}; confirme.`);
    }
  }
  switch (sub) {
    case 'push':
      checkGitPush(rest, restDynamic, gitCtx, v, configs, depth);
      break;
    case 'commit':
      checkGitCommitShortFlags(rest, v);
      break;
    case 'rebase':
      for (const command of gitCommandOptions(rest, ['-x'], ['--exec'])) {
        analyzeScript(command, gitCtx, depth + 1, v);
        v.ask(`git rebase --exec executa "${command.slice(0, 80)}" a cada commit; confirme.`);
      }
      break;
    case 'difftool':
    case 'mergetool':
      for (const command of gitCommandOptions(rest, ['-x'], ['--extcmd'])) {
        analyzeScript(command, gitCtx, depth + 1, v);
        v.ask(`git ${sub} --extcmd executa "${command.slice(0, 80)}"; confirme.`);
      }
      break;
    case 'bisect':
      if (rest[0] === 'run' && rest.length > 1) {
        analyzeArgv(rest.slice(1), restDynamic.slice(1), cmd, all, gitCtx, depth + 1, v);
      }
      break;
    case 'submodule': {
      const at = rest.indexOf('foreach');
      if (at >= 0) {
        const script = rest.slice(at + 1);
        while (script.length > 1 && (script[0] ?? '').startsWith('-')) script.shift();
        analyzeScript(script.join(' '), gitCtx, depth + 1, v);
      }
      break;
    }
    case 'fetch':
    case 'pull':
    case 'clone':
    case 'ls-remote':
    case 'archive': {
      const short = sub === 'clone' ? ['-u'] : [];
      for (const command of gitCommandOptions(rest, short, ['--upload-pack', '--exec'])) {
        analyzeScript(command, gitCtx, depth + 1, v);
        v.ask(`git ${sub} --upload-pack/--exec executa "${command.slice(0, 80)}"; confirme.`);
      }
      break;
    }
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
      checkGitPathWrites('checkout', rest, gitCtx, v);
      break;
    }
    case 'restore': {
      const onlyStaged =
        rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W');
      if (!onlyStaged && rest.some((p) => p === '.' || p === '*' || p === ':/')) {
        v.ask('git restore descarta mudanças locais; confirme.');
      }
      checkGitPathWrites('restore', rest, gitCtx, v);
      break;
    }
    case 'rm':
      // `git rm <paths>` apaga do índice E da árvore (salvo --cached). Trata os caminhos como
      // escrita para proteger .claude/hooks, lockfiles etc.
      if (!rest.includes('--cached')) {
        for (const p of rest.filter((a) => !a.startsWith('-'))) {
          checkWriteTarget(p, gitCtx, v, 'git rm');
        }
      }
      break;
    case 'mv':
      // `git mv <src> <dst>`: a origem é removida e o destino escrito.
      for (const p of rest.filter((a) => !a.startsWith('-'))) {
        checkWriteTarget(p, gitCtx, v, 'git mv');
      }
      break;
    case 'apply':
    case 'am':
    case 'read-tree':
      // O conteúdo do patch/árvore não é visível ao guard; se altera a árvore de trabalho,
      // pede confirmação (pode tocar .claude/hooks, migrações...).
      if (sub === 'apply' && (rest.includes('--cached') || rest.includes('--check'))) break;
      if (sub === 'read-tree' && !rest.includes('-u') && !rest.includes('--reset')) break;
      v.ask(`git ${sub} altera a árvore de trabalho com conteúdo que o guard não vê; confirme.`);
      break;
    case 'switch':
      if (rest.some((a) => a === '-f' || a === '--force' || a === '--discard-changes')) {
        v.ask('git switch descartando mudanças locais; confirme.');
      }
      break;
    case 'stash':
      if (rest[0] === 'drop' || rest[0] === 'clear') v.ask('Remover stash; confirme.');
      else checkGitStashPaths(rest, gitCtx, v);
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
    case 'config':
      checkGitConfigCommand(rest, gitCtx, depth, v);
      break;
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
 * `git config`: separa leitura de escrita (forma antiga `git config chave valor`, opções
 * `--add`/`--unset`/`--get-all`... e subcomandos do git 2.46+ `get`/`set`/`unset`/`list`).
 * @param {string[]} rest
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 */
function checkGitConfigCommand(rest, ctx, depth, v) {
  const valueOpts = new Set([
    '-f',
    '--file',
    '--blob',
    '-t',
    '--type',
    '--default',
    '--comment',
    '--value',
  ]);
  const subcommands = /** @type {Record<string, string>} */ ({
    list: 'read',
    get: 'read',
    set: 'write',
    unset: 'unset',
    edit: 'edit',
    'rename-section': 'section',
    'remove-section': 'section',
  });
  /** @type {string | null} */
  let action = null;
  let scopeGlobal = false;
  /** @type {string[]} */
  const positionals = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? '';
    if (a === '--') {
      positionals.push(...rest.slice(k + 1));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      if (valueOpts.has(a)) {
        k++;
        continue;
      }
      const name = a.split('=')[0] ?? '';
      if (
        /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|-l|--list)$/.test(
          name,
        )
      ) {
        action ??= 'read';
      } else if (name === '--unset' || name === '--unset-all') action = 'unset';
      else if (name === '-e' || name === '--edit') action = 'edit';
      else if (name === '--rename-section' || name === '--remove-section') action = 'section';
      else if (name === '--add' || name === '--replace-all') action = 'write';
      else if (name === '--global' || name === '--system') scopeGlobal = true;
      continue;
    }
    positionals.push(a);
  }
  const first = positionals[0] ?? '';
  if (action === null && subcommands[first] !== undefined) {
    action = subcommands[first] ?? null;
    positionals.shift();
  }
  if (action === null) action = positionals.length >= 2 ? 'write' : 'read';
  if (action === 'read' || action === 'unset') return;
  if (action === 'edit') {
    v.ask('git config --edit pode alterar qualquer chave (inclusive core.hooksPath); confirme.');
    return;
  }
  if (action === 'section') {
    if (
      positionals.some((p) => /^(?:core|include|includeif|alias|remote|branch|push)\b/i.test(p))
    ) {
      v.ask('git config --rename/--remove-section numa seção sensível; confirme.');
    }
    return;
  }
  const key = positionals[0] ?? '';
  const value = positionals[1] ?? null;
  checkGitConfigEntry({ key, value, source: 'config' }, 'persist', ctx, depth, v);
  if (/^credential\./i.test(key)) v.ask(`git config ${key}: confirme.`);
  if (scopeGlobal) v.ask('Alteração de configuração global do git; confirme.');
}

/**
 * `git checkout <ref> -- <paths>` e `git restore [--source=X] <paths>` sobrescrevem arquivos.
 * Em `restore` não há ref posicional (a ref vem de `--source`/`-s`), então todo posicional é
 * caminho; em `checkout` sem `--`, o primeiro posicional é a ref.
 * @param {'checkout' | 'restore'} sub
 * @param {string[]} rest
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkGitPathWrites(sub, rest, ctx, v) {
  const dd = rest.indexOf('--');
  /** @type {string[]} */
  let paths;
  if (dd >= 0) {
    paths = rest.slice(dd + 1);
  } else {
    /** @type {string[]} */
    const positionals = [];
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k] ?? '';
      if (a === '--source' || a === '-s') {
        k++; // valor da ref de origem, não é caminho
        continue;
      }
      if (a.startsWith('-')) continue; // opção (inclui --source=, -sREF)
      positionals.push(a);
    }
    // checkout: 1º posicional é a ref. restore: todos são caminhos.
    paths = sub === 'restore' ? positionals : positionals.slice(1);
  }
  for (const p of paths) checkWriteTarget(p, ctx, v, `git ${sub}`);
}

/**
 * `git stash [push] [opções] [--] <caminho>...` volta esses caminhos ao HEAD na árvore de
 * trabalho: é escrita neles, como `git checkout -- <caminho>` (nega em .claude/hooks e
 * settings). `-m`/`--message` (e prefixo, `--mess`) leva valor; caminhos vindos de
 * `--pathspec-from-file` não são visíveis e pedem confirmação. Sem caminho, o stash volta a
 * árvore inteira ao HEAD, como trocar de branch, e não é tratado aqui.
 * @param {string[]} rest argumentos depois de `stash`
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkGitStashPaths(rest, ctx, v) {
  let k = 0;
  if (rest[0] === 'push') k = 1;
  else if (rest[0] !== undefined && !rest[0].startsWith('-')) return; // pop, apply, save, list...
  /** @type {string[]} */
  const paths = [];
  for (; k < rest.length; k++) {
    const a = rest[k] ?? '';
    if (a === '--') {
      paths.push(...rest.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      if (name.length >= '--pathspec-fr'.length && '--pathspec-from-file'.startsWith(name)) {
        v.ask(
          'git stash com caminhos lidos de arquivo (--pathspec-from-file); confirme que não inclui .claude/hooks nem settings.',
        );
        if (eq < 0) k++;
      } else if (name.length >= '--m'.length && '--message'.startsWith(name) && eq < 0) {
        k++;
      }
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      // `-m` com valor anexado (`-mwip`) ou no argumento seguinte (`-qm wip`).
      if (a.indexOf('m') === a.length - 1) k++;
      continue;
    }
    paths.push(a);
  }
  for (const p of paths) checkWriteTarget(p, ctx, v, 'git stash');
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
 * Configuração que decide para onde vai um `git push` sem refspec: `-c`/ambiente da própria
 * linha (`transient`) e a persistida no repositório.
 * @param {GitConfigEntry[]} transient
 * @param {Array<[string, string]>} persisted
 * @param {string | undefined} remote
 * @param {string | null} branch
 * @param {Verdict} v
 */
function checkPushConfig(transient, persisted, remote, branch, v) {
  const entries = [
    ...transient.map((e) => ({ key: e.key.toLowerCase(), value: e.value, transient: true })),
    ...persisted.map(([key, value]) => ({ key: key.toLowerCase(), value, transient: false })),
  ];
  const upstreamMode = entries.some(
    (e) => e.key === 'push.default' && /^(?:upstream|tracking)$/i.test(e.value ?? ''),
  );
  for (const e of entries) {
    const where = e.transient ? `-c ${e.key}` : `configuração ${e.key} do repositório`;
    const remoteOf = /^remote\.(.+)\.(?:push|mirror)$/.exec(e.key)?.[1];
    if (
      remoteOf !== undefined &&
      remote !== undefined &&
      !e.transient &&
      remoteOf !== remote.toLowerCase()
    ) {
      continue;
    }
    if (/^remote\..+\.push$/.test(e.key)) {
      if (e.value === null) v.ask(`git push com ${where} vindo do ambiente; confirme.`);
      else if (checkRefspec(e.value, branch, v, where) && e.transient) {
        v.ask(`git push com refspec definido por ${where}; confirme o destino.`);
      }
    } else if (/^remote\..+\.mirror$/.test(e.key)) {
      if (e.value === null || isTruthy(e.value)) {
        v.deny(
          `git push com ${where}=true equivale a --mirror (sobrescreve todas as refs remotas); proibido.`,
        );
      }
    } else if (e.key === 'push.default') {
      if (e.transient || /^matching$/i.test(e.value ?? '')) {
        if (/^(?:matching|upstream|tracking)$/i.test(e.value ?? '') || e.value === null) {
          v.ask(`git push com push.default=${e.value ?? '?'} (${where}); confirme o destino.`);
        }
      }
    } else if (/^branch\..+\.merge$/.test(e.key)) {
      const forCurrent = branch !== null && e.key === `branch.${branch.toLowerCase()}.merge`;
      if (
        upstreamMode &&
        (e.transient || forCurrent) &&
        isProtectedBranch(normalizeBranchRef(e.value ?? ''))
      ) {
        v.deny(
          `git push com push.default=upstream e ${e.key}=${e.value} envia para a branch protegida; proibido.`,
        );
      } else if (e.transient) {
        v.ask(`git push com ${where}; confirme o destino.`);
      }
    } else if (
      e.transient &&
      /^(?:remote\.pushdefault|branch\..+\.(?:pushremote|remote))$/.test(e.key)
    ) {
      v.ask(`git push com ${where}; confirme o destino.`);
    }
  }
}

/**
 * @param {string[]} rest
 * @param {boolean[]} restDynamic
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 * @param {GitConfigEntry[]} configs
 * @param {number} depth
 */
function checkGitPush(rest, restDynamic, ctx, v, configs, depth) {
  let force = false;
  let lease = false;
  let del = false;
  let all = false;
  let mirror = false;
  /** @type {Array<{ value: string, dynamic: boolean }>} */
  const positionals = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? '';
    if (a === '--') {
      for (let j = k + 1; j < rest.length; j++) {
        positionals.push({ value: rest[j] ?? '', dynamic: restDynamic[j] ?? false });
      }
      break;
    }
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      if (name === '--force') force = true;
      else if (name === '--force-with-lease' || name === '--force-if-includes') lease = true;
      else if (name === '--delete') del = true;
      else if (name === '--all' || name === '--branches') all = true;
      else if (name === '--mirror') mirror = true;
      if (name === '--receive-pack' || name === '--exec') {
        const command = a.includes('=') ? a.slice(a.indexOf('=') + 1) : (rest[k + 1] ?? '');
        analyzeScript(command, ctx, depth + 1, v);
        v.ask(`git push ${name} executa "${command.slice(0, 80)}" no destino; confirme.`);
      }
      if (!a.includes('=') && gitOptionTakesValue('push', name ?? '')) k++;
      continue;
    }
    // Agrupamento de opções curtas (`-uf`, `-4f`, `-fo opção`): `-o` leva valor (o resto do
    // agrupamento ou o argumento seguinte).
    if (/^-[A-Za-z0-9]/.test(a)) {
      for (let c = 1; c < a.length; c++) {
        const flag = a.charAt(c);
        if (flag === 'f') force = true;
        else if (flag === 'd') del = true;
        else if (flag === 'o') {
          if (c === a.length - 1) k++;
          break;
        }
      }
      continue;
    }
    positionals.push({ value: a, dynamic: restDynamic[k] ?? false });
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
  const remote = positionals[0]?.dynamic ? undefined : positionals[0]?.value;
  // `git checkout|switch` na mesma linha muda o HEAD antes do push; usa o branch rastreado.
  const unknownHead = ctx.headBranch === 'unknown';
  const branches = unknownHead
    ? []
    : ctx.headBranch !== undefined
      ? [ctx.headBranch]
      : cwdCandidates(ctx).map((cwd) => ctx.currentBranch(cwd));
  const branch = branches[0] ?? null;
  if (refspecs.length === 0) {
    if (unknownHead) {
      v.ask(
        'git push depois de trocar de branch na mesma linha (HEAD desconhecido); confirme o destino.',
      );
      return;
    }
    if (!all && !mirror) {
      for (const b of branches) {
        if (b && isProtectedBranch(b)) {
          v.deny(`Push da branch ${b} (protegida) é proibido; trabalhe numa branch e abra um PR.`);
        }
      }
      // Upstream definido na mesma linha (`git checkout -b x origin/main`, `--track`,
      // `git branch -u`): com push.default=upstream, `git push` sem refspec envia para ele.
      const upstream = ctx.headUpstream;
      if (upstream === 'unknown') {
        v.ask(
          'git push sem refspec depois de definir o upstream na mesma linha (--track=inherit, origin/HEAD, nome de remoto sozinho ou valor dinâmico); confirme o destino.',
        );
      } else if (typeof upstream === 'string' && isProtectedBranch(upstream)) {
        v.deny(
          `git push sem refspec com upstream ${upstream} definido na mesma linha: com push.default=upstream envia para a branch protegida; proibido. Use git push -u origin HEAD.`,
        );
      }
      const persisted = ctx.gitConfigList ? ctx.gitConfigList(ctx.cwd) : [];
      checkPushConfig(
        configs.filter((c) => isPushConfigKey(c.key)),
        persisted,
        remote,
        branch,
        v,
      );
    }
    return;
  }
  if (unknownHead && refspecs.some((s) => !s.dynamic && /^(?:HEAD|@)(?::|$)/.test(s.value))) {
    v.ask('git push de HEAD depois de trocar de branch na mesma linha; confirme o destino.');
  }
  for (const spec of refspecs) {
    /** @type {string[]} */
    let values = [spec.value];
    if (spec.dynamic || /[$`]/.test(spec.value)) {
      const expanded = expandWord(spec.value, ctx.vars);
      if (expanded.unresolved) {
        v.ask(`git push com refspec dinâmico (${spec.value}); confirme o destino.`);
        continue;
      }
      values = expanded.values;
    }
    for (const value of values) checkRefspec(value, branch, v, 'git push', del);
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
 * Linguagem do código inline de um interpretador.
 * @param {string} bin
 * @returns {'node' | 'python' | 'perl' | 'ruby' | 'php' | 'deno' | 'shell'}
 */
function languageOf(bin) {
  const family = interpreterFamily(bin);
  if (family === 'python' || family === 'perl' || family === 'ruby' || family === 'php') {
    return family;
  }
  if (bin === 'deno') return 'deno';
  if (SHELL_BINS.has(bin)) return 'shell';
  return 'node';
}

/**
 * `deno eval [opções] CÓDIGO` e `--eval CÓDIGO`. Como o guard não conhece a aridade de cada
 * opção do deno, todo argumento posicional depois de `eval` é analisado como código.
 * @param {string[]} args
 * @param {boolean[]} dynamic
 * @param {PolicyContext} ctx
 * @param {number} depth
 * @param {Verdict} v
 * @returns {{ hasInline: boolean, hasScript: boolean }}
 */
function checkDenoArgs(args, dynamic, ctx, depth, v) {
  /** @param {string} code @param {number} index */
  const inline = (code, index) => {
    if (index >= 0 && dynamic[index]) v.ask('deno eval com código dinâmico; confirme.');
    checkInlineCode(code, v, ctx, 'deno', depth);
  };
  let hasInline = false;
  const first = args.findIndex((a) => !a.startsWith('-'));
  const isEval = first >= 0 && args[first] === 'eval';
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? '';
    if (a === '--eval' || a.startsWith('--eval=')) {
      hasInline = true;
      if (a === '--eval') inline(args[k + 1] ?? '', k + 1);
      else inline(a.slice('--eval='.length), -1);
    } else if (isEval && k > first && !a.startsWith('-')) {
      hasInline = true;
      inline(a, k);
    }
  }
  return { hasInline, hasScript: first >= 0 && !isEval && args[first] !== 'repl' };
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
function checkInterpreter(bin, args, dynamic, cmd, all, ctx, depth, v) {
  const lang = languageOf(bin);
  let hasInline = false;
  let hasScript = false;
  if (bin === 'deno') {
    ({ hasInline, hasScript } = checkDenoArgs(args, dynamic, ctx, depth, v));
  } else {
    // Opções agrupadas (`python3 -Ic`, `perl -lne`), anexadas (`-cCODE`) e com valor antes
    // do código (`node -r ./x -e`, `perl -I lib -e`) seguem a tabela de cada interpretador.
    const parsed = parseInterpreterArgs(bin, args);
    for (const opt of parsed.envDump) {
      v.deny(`${bin} ${opt} imprime o ambiente inteiro (phpinfo), inclusive segredos.`);
    }
    for (const opt of parsed.unknown) {
      v.ask(
        `${bin} ${opt}: opção que o guard-bash não sabe analisar (pode trazer código inline); confirme.`,
      );
    }
    for (const inline of parsed.inline) {
      if (inline.index >= 0 && dynamic[inline.index]) {
        v.ask(`${bin} ${inline.flag} com código dinâmico; confirme.`);
      }
      checkInlineCode(inline.code, v, ctx, lang, depth);
    }
    hasInline = parsed.inline.length > 0;
    hasScript = parsed.script;
  }
  // `python3 <(echo ...)` / `node < <(...)`: o script vem da substituição de processo.
  if (
    !hasInline &&
    (args.includes('/dev/fd/63') ||
      cmd.redirects.some((r) => r.op === '<' && r.target === '/dev/fd/63')) &&
    cmd.processSubstitutions.length > 0
  ) {
    checkProcessSubstitutionScript(bin, cmd, ctx, depth, v, bin);
    return;
  }
  // `python3 /dev/stdin`, `perl /dev/fd/0`: o "script em arquivo" é a entrada padrão.
  const stdinScript = args.some((a) => STDIN_SCRIPT_PATH.test(a));
  if (!hasInline && (!hasScript || stdinScript)) {
    for (const heredoc of cmd.heredocs) checkInlineCode(heredoc.body, v, ctx, lang, depth);
    for (const text of cmd.hereStrings) checkInlineCode(text, v, ctx, lang, depth);
    if (cmd.heredocs.length === 0 && cmd.hereStrings.length === 0) {
      checkPipeIntoInterpreter(cmd, all, v, bin, ctx, depth);
    }
  }
}

/**
 * Despejo do ambiente inteiro ou de variável sensível, por linguagem.
 * @param {string} code
 * @param {Verdict} v
 * @param {string} lang
 */
function checkInlineEnvAccess(code, v, lang) {
  /** @param {string} name */
  const sensitive = (name) => {
    if (isSensitiveVarName(name)) {
      v.deny(`Acesso a variável sensível (${name}) em código inline bloqueado.`);
    }
  };
  // Node/Bun/Deno: normaliza `process . env`, `process["env"]`, `require("process").env`.
  const js = code
    .replace(/\s*\.\s*/g, '.')
    .replace(/\brequire\s*\(\s*(['"`])(?:node:)?process\1\s*\)/g, 'process')
    .replace(/\bglobalThis\.process\b/g, 'process')
    .replace(/\bprocess\s*\[\s*(['"`])env\1\s*\]/g, 'process.env');
  if (
    /process\.env(?!\s*(?:\.\s*[A-Za-z_$]|\[\s*['"`]))/.test(js) ||
    /\{[^}]*\benv\b[^}]*\}\s*=\s*process\b/.test(js) ||
    /\bimport\s*\{[^}]*\benv\b[^}]*\}\s*from\s*['"](?:node:)?process['"]/.test(code) ||
    /\bBun\.env(?!\s*(?:\.\s*[A-Za-z_$]|\[\s*['"`]))/.test(js) ||
    /\bimport\.meta\.env(?!\s*(?:\.\s*[A-Za-z_$]|\[\s*['"`]))/.test(js)
  ) {
    v.deny('Despejar process.env inteiro expõe segredos.');
  }
  for (const m of js.matchAll(
    /(?:process|Bun)\.env\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"`]([^'"`]+)['"`]\s*\])/g,
  )) {
    sensitive(m[1] ?? m[2] ?? '');
  }
  if (
    /\bos\.environb?\b(?!\s*(?:\[|\.get\s*\())/.test(code) ||
    /%ENV\b/.test(code) ||
    /\bDeno\.env\.toObject\s*\(/.test(code)
  ) {
    v.deny('Despejar o ambiente inteiro em código inline expõe segredos.');
  }
  if (lang === 'python' && /\benvironb?\b(?!\s*(?:\[|\.get\s*\())/.test(code)) {
    v.deny('Despejar o ambiente inteiro (os.environ) em código inline expõe segredos.');
  }
  if (
    lang === 'ruby' &&
    /(?<![$%@\w.:])ENV\b(?!\s*(?:\[|\.fetch\s*\(|\.key\?|\.has_key\?|\.include\?))/.test(code)
  ) {
    v.deny('Despejar o ambiente inteiro (ENV) em código inline expõe segredos.');
  }
  if (
    lang === 'php' &&
    (/\bgetenv\s*\(\s*\)/.test(code) ||
      /\$_(?:ENV|SERVER)\b(?!\s*\[)/.test(code) ||
      /\bphpinfo\s*\(/.test(code))
  ) {
    v.deny('Despejar o ambiente inteiro (getenv(), $_ENV, $_SERVER, phpinfo) expõe segredos.');
  }
  for (const m of code.matchAll(
    /(?:\benviron\s*\[\s*|\benviron\.get\s*\(\s*|\bgetenv\s*\(\s*|\bENV\s*\[\s*|\bENV\.fetch\s*\(\s*|\$ENV\{\s*|\$_(?:ENV|SERVER)\s*\[\s*|Deno\.env\.get\s*\(\s*)['"]?([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    sensitive(m[1] ?? '');
  }
}

/** Escrita em arquivo por código inline (Node, Python, Ruby, Perl, PHP). */
const INLINE_WRITE_API =
  /\b(?:writeFile|appendFile|createWriteStream|copyFile|rename|unlink|rmSync|rm|truncate|write_text|write_bytes|unlinkSync|renameSync|copyFileSync|truncateSync|file_put_contents|fwrite)\b|\bopen\s*\([^)]*,\s*['"][wax+]/;

/**
 * Regras para código passado inline (`node -e`, `python -c`, heredoc para interpretador).
 * @param {string} code
 * @param {Verdict} v
 * @param {PolicyContext} ctx
 * @param {string} lang
 * @param {number} [depth]
 */
function checkInlineCode(code, v, ctx, lang, depth = 0) {
  if (lang === 'shell') return;
  checkInlineEnvAccess(code, v, lang);
  const perlOrRuby = lang === 'perl' || lang === 'ruby';
  if (
    /\bchild_process\b|\bexecSync\s*\(|\bspawnSync\s*\(|\bexecFileSync\s*\(|\bsubprocess\b|\bos\.system\s*\(|\bos\.popen\s*\(|\bBun\.spawn|\bDeno\.(?:Command|run)\b|\bProcessBuilder\b|\bshell_exec\s*\(|\bpassthru\s*\(/.test(
      code,
    ) ||
    ((perlOrRuby || lang === 'php') &&
      /\b(?:system|exec|popen|spawn)\s*\(|`|\bqx\s*[({[/]|%x\s*[({[]/.test(code))
  ) {
    // O texto literal passado ao shell é analisado como script (`system("rm -rf ~")`).
    for (const m of code.matchAll(
      /\b(?:system|exec|execSync|popen|spawnSync|shell_exec|passthru|check_output|check_call|run|call|Popen)\s*\(\s*(['"`])((?:(?!\1)[^\\]|\\.){1,500})\1/g,
    )) {
      analyzeScript(m[2] ?? '', ctx, depth + 1, v);
    }
    v.ask('Código inline que executa comandos de shell; confirme o que será executado.');
  }
  const writes = INLINE_WRITE_API.test(code);
  for (const m of code.matchAll(/['"`]([^'"`\n]{1,300})['"`]/g)) {
    const literal = m[1] ?? '';
    for (const candidate of pathCandidates(literal)) {
      const secret = classifySecretPath(candidate);
      if (secret) {
        v.deny(`Código inline acessando ${secret.reason} bloqueado.`);
        return;
      }
    }
    checkInlinePath(literal, writes, ctx, v);
  }
}

/**
 * Caminho citado em código inline: configuração protegida do agente é negada com qualquer
 * API (o guard não acompanha o fluxo do programa); lockfile, só quando o código escreve.
 * @param {string} literal
 * @param {boolean} writes
 * @param {PolicyContext} ctx
 * @param {Verdict} v
 */
function checkInlinePath(literal, writes, ctx, v) {
  if (!/[./]/.test(literal) || /\s/.test(literal) || /^[a-z]+:\/\//i.test(literal)) return;
  const expanded = literal.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
  const bases = path.isAbsolute(expanded) ? [''] : cwdCandidates(ctx);
  for (const base of bases) {
    const abs = path.resolve(base || '/', expanded);
    if (userClaudeConfigLevel(abs) === 'deny') {
      v.deny(
        `Código inline citando ${abs} (configuração do Claude Code no escopo do usuário) bloqueado. Use a ferramenta Edit: o guard-files pede confirmação humana.`,
      );
      return;
    }
    const rel = path.relative(ctx.projectDir, abs).split(path.sep).join('/');
    const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    const level = inside ? protectedConfigLevel(rel) : null;
    if (level === 'deny') {
      v.deny(
        `Código inline citando ${rel} (configuração protegida do agente) bloqueado. Use a ferramenta Edit: o guard-files pede confirmação humana.`,
      );
      return;
    }
    if (level === 'ask')
      v.ask(`Código inline citando ${rel} (configuração de hooks/MCP); confirme.`);
    if (writes && isLockfile(abs)) {
      v.deny(`Não edite ${path.basename(abs)} por código inline; use pnpm install/add/remove.`);
      return;
    }
  }
}
