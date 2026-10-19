// @ts-check
/**
 * Classificação de caminhos sensíveis, compartilhada por guard-bash e guard-files.
 * Mantenha as listas curtas e explícitas: cada entrada é uma decisão de segurança.
 * Toda família de segredo daqui precisa de uma regra `Read(...)` equivalente em
 * `permissions.deny` do `.claude/settings.json` (test/settings-deny.test.mjs confere).
 */
import path from 'node:path';

/** Único arquivo .env* que o agente pode ler e editar (modelo sem valores reais). */
const ENV_EXAMPLE = '.env.example';

/**
 * Nomes de arquivo (basename, sem diferenciar maiúsculas) que guardam segredos.
 * `.env.example` é tratado à parte, antes destas regras.
 */
const SECRET_BASENAMES = [
  /^\.env(?:\..+)?$/i,
  /^\.envrc$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|ppk|p8|der|crt|cer|kdbx)$/i,
  /^(?:credentials|client_secrets?(?:[-_.][\w.-]*)?|service[-_]?account(?:[-_.][\w.-]*)?)\.json$/i,
  /^\.(?:git-credentials|npmrc|yarnrc\.yml|pypirc|netrc|pgpass|my\.cnf)$/i,
  /^\.credentials\.json$/i,
  /^secrets?\.(?:json|ya?ml|toml|env|txt)$/i,
  /^terraform\.tfstate(?:\.backup)?$/i,
  // Históricos de shell e de clientes guardam comandos com senha/token colados.
  /^\.(?:bash|zsh|sh|ksh|psql|mysql|sqlite|python|node_repl|rediscli|irb)_history$/i,
  /^(?:\.lesshst|fish_history)$/i,
  // Estado do Claude Code: conta OAuth, servidores MCP (com env) e projetos.
  /^\.claude\.json(?:\.backup)?$/i,
];

/** Diretórios (segmentos de caminho) que só contêm credenciais ou estado sensível. */
const SECRET_DIR_SEQUENCES = [
  ['.ssh'],
  ['.aws'],
  ['.gnupg'],
  ['.kube'],
  ['.azure'],
  ['.docker'],
  ['.config', 'gh'],
  ['.config', 'gcloud'],
  ['secrets'],
  // Variáveis definidas por hooks de SessionStart e fotos do ambiente do shell.
  ['.claude', 'session-env'],
  ['.claude', 'shell-snapshots'],
];

/** Nomes representativos usados para avaliar se um glob pode casar com um segredo. */
const SECRET_SAMPLES = [
  '.env',
  '.env.local',
  '.env.production',
  '.envrc',
  'id_rsa',
  'id_ed25519',
  'server.key',
  'cert.pem',
  'keystore.p12',
  'credentials.json',
  'service-account.json',
  '.npmrc',
  '.git-credentials',
  '.netrc',
  '.pgpass',
  'secrets.json',
  '.bash_history',
  '.zsh_history',
  '.claude.json',
];

/**
 * Arquivos comuns do repositório. Um glob que casa algum deles é genérico demais para ser
 * tratado como "segredo" (`*.json` casa `credentials.json`, mas também `package.json`).
 * Nenhum começa com ponto: `.e*`, `.env*` e `.*` continuam avaliados só contra os segredos.
 */
const BENIGN_SAMPLES = [
  'package.json',
  'tsconfig.json',
  '0000_snapshot.json',
  '_journal.json',
  'config.yaml',
  'index.ts',
  'README.md',
  'notes.txt',
  'settings.toml',
];

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

/**
 * Remove decorações comuns de um argumento antes de tratá-lo como caminho:
 * `@arquivo` (curl), `file://`, `--opcao=valor` (devolve o valor), `<`/`>` colados.
 * @param {string} token
 * @returns {string[]} candidatos a caminho
 */
export function pathCandidates(token) {
  /** @type {string[]} */
  const out = [];
  const raw = String(token).trim();
  if (raw === '') return out;
  /** @param {string} value */
  const add = (value) => {
    let v = value.trim().replace(/^[<>]+/, '');
    if (v.startsWith('file://')) v = v.slice('file://'.length);
    if (v.startsWith('@')) v = v.slice(1);
    if (v !== '' && !out.includes(v)) out.push(v);
  };
  add(raw);
  const eq = raw.indexOf('=');
  if (eq > 0) add(raw.slice(eq + 1));
  const colon = raw.indexOf(':');
  if (colon > 0 && !raw.includes('://')) add(raw.slice(colon + 1));
  return out;
}

/**
 * Converte um glob de basename em RegExp (apenas `*`, `?` e `[...]`).
 * @param {string} glob
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        re += `[${glob
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * O glob pode casar um nome que começa com ponto? No shell e no ripgrep, `*`, `?` e
 * classes sem `.` explícito não casam o ponto inicial.
 * @param {string} glob
 */
function globMatchesLeadingDot(glob) {
  return glob.startsWith('.') || /^\[[^\]]*\.[^\]]*\]/.test(glob);
}

/**
 * @param {RegExp} re
 * @param {string} glob
 * @param {string[]} samples
 */
function globHits(re, glob, samples) {
  const dot = globMatchesLeadingDot(glob);
  return samples.some((sample) => (dot || !sample.startsWith('.')) && re.test(sample));
}

/**
 * @param {string} glob
 * @returns {RegExp | null}
 */
function compileGlob(glob) {
  try {
    return globToRegExp(glob);
  } catch {
    return null;
  }
}

/**
 * @param {string} base
 * @returns {boolean}
 */
function isSecretBasename(base) {
  if (base.toLowerCase() === ENV_EXAMPLE) return false;
  // Pacotes de certificados de AC são públicos (ex.: ca-bundle.crt, ca-certificates.crt).
  if (/^ca[-_.]?(?:bundle|certificates?)(?:[-_.][\w-]+)?\.(?:crt|pem)$/i.test(base)) return false;
  if (/[*?[]/.test(base)) {
    if (base === '*' || base === '.*' || base === '**') return false;
    const re = compileGlob(base);
    if (!re) return false;
    return globHits(re, base, SECRET_SAMPLES) && !globHits(re, base, BENIGN_SAMPLES);
  }
  return SECRET_BASENAMES.some((re) => re.test(base));
}

/**
 * Glob de basename que começa com ponto e alcança um segredo (`.*`, `.??*`, `.[a-z]*`).
 * `classifySecretPath` libera `.*` porque a ferramenta Grep já exclui os segredos pelas
 * regras nativas; para comandos de shell que despejam conteúdo (`cat .*`) isso não vale.
 * @param {string} candidate
 * @returns {boolean}
 */
export function dotGlobReachesSecret(candidate) {
  const base = path.posix.basename(String(candidate).replace(/\\/g, '/'));
  if (!/[*?[]/.test(base) || !globMatchesLeadingDot(base)) return false;
  const re = compileGlob(base);
  return re !== null && globHits(re, base, SECRET_SAMPLES);
}

/**
 * @typedef {object} SecretMatch
 * @property {'file' | 'dir' | 'proc'} kind
 * @property {string} reason motivo legível em pt-BR
 */

/**
 * Indica se o caminho aponta para um segredo (arquivo .env*, chave, credencial) ou para
 * dentro de um diretório de credenciais (~/.ssh, ~/.aws, ...). Funciona com caminhos
 * relativos, absolutos, com `~` e com globs simples.
 * @param {string} candidate
 * @returns {SecretMatch | null}
 */
export function classifySecretPath(candidate) {
  const p = String(candidate).replace(/\\/g, '/');
  if (p === '' || p.includes('\n') || p.length > 4096) return null;
  if (isProcEnvironPath(p)) {
    return { kind: 'proc', reason: 'ambiente de outro processo (/proc/*/environ)' };
  }
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  for (const seq of SECRET_DIR_SEQUENCES) {
    for (let i = 0; i + seq.length <= segments.length; i++) {
      if (seq.every((s, k) => segments[i + k]?.toLowerCase() === s)) {
        // Em ~/.docker só o config.json guarda credenciais.
        const isDocker = seq.length === 1 && seq[0] === '.docker';
        if (isDocker && segments[i + 1] !== 'config.json') continue;
        return { kind: 'dir', reason: `diretório de credenciais (${seq.join('/')})` };
      }
    }
  }
  const base = segments.at(-1) ?? '';
  // Transcrições do Claude Code (podem conter segredos colados); a memória (.md) fica livre.
  const claude = segments.findIndex((s) => s.toLowerCase() === '.claude');
  if (claude >= 0 && /\.jsonl$/i.test(base)) {
    const next = segments[claude + 1]?.toLowerCase();
    if (next === 'projects' || base.toLowerCase() === 'history.jsonl') {
      return { kind: 'file', reason: `transcrição/histórico do Claude Code (${base})` };
    }
  }
  if (base !== '' && isSecretBasename(base)) {
    return { kind: 'file', reason: `arquivo de segredo (${base})` };
  }
  return null;
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
export function isLockfile(candidate) {
  const base = path.posix.basename(String(candidate).replace(/\\/g, '/'));
  return LOCKFILES.has(base);
}

/**
 * Caminhos de configuração dos próprios guardas e dos hooks de git. Alterá-los por Bash
 * desligaria a proteção sem passar pela confirmação humana que o guard-files (e, no CLI
 * local, `permissions.ask`) pede para editar esses caminhos com as ferramentas de arquivo.
 * @param {string} rel caminho relativo à raiz do projeto, com `/`
 * @returns {'deny' | 'ask' | null}
 */
export function protectedConfigLevel(rel) {
  const p = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(p)) return 'deny';
  if (/(^|\/)\.claude\/hooks(\/|$)/.test(p)) return 'deny';
  if (/(^|\/)\.claude\/mcp(\/|$)/.test(p)) return 'ask';
  if (/(^|\/)\.git\/hooks(\/|$)/.test(p)) return 'ask';
  if (/(^|\/)\.git\/config$/.test(p)) return 'ask';
  if (/(^|\/)\.husky(\/|$)/.test(p)) return 'ask';
  // Todos os nomes que o lefthook 2 lê: com ou sem ponto, na raiz ou em .config/.
  if (/(^|\/)\.?lefthook(-local)?\.(?:ya?ml|jsonc?|toml)$/.test(p)) return 'ask';
  if (/(^|\/)\.mcp\.json$/.test(p)) return 'ask';
  return null;
}

/** Caminhos de amostra que representam a configuração protegida (para testar globs). */
const PROTECTED_SAMPLES = /** @type {Array<[string, 'deny' | 'ask']>} */ ([
  ['.claude/settings.json', 'deny'],
  ['.claude/settings.local.json', 'deny'],
  ['.claude/hooks/guard-bash.mjs', 'deny'],
  ['.claude/hooks/lib/paths.mjs', 'deny'],
  ['.claude/mcp/server.json', 'ask'],
  ['.mcp.json', 'ask'],
  ['.git/hooks/pre-commit', 'ask'],
  ['.git/config', 'ask'],
  ['.husky/pre-commit', 'ask'],
  ['lefthook.yml', 'ask'],
  ['.lefthook.yml', 'ask'],
  ['.config/lefthook.yml', 'ask'],
  ['pnpm-lock.yaml', 'deny'],
  ['package-lock.json', 'deny'],
  ['yarn.lock', 'deny'],
  ['bun.lock', 'deny'],
]);

/**
 * Expande chaves simples (`{a,b}`, inclusive vazias) num glob; limite para evitar explosão.
 * @param {string} glob
 * @returns {string[]}
 */
function expandBraces(glob) {
  /** @type {string[]} */
  const done = [];
  const queue = [glob];
  while (queue.length > 0 && done.length + queue.length <= 64) {
    const item = /** @type {string} */ (queue.shift());
    const open = item.indexOf('{');
    if (open < 0) {
      done.push(item);
      continue;
    }
    let depth = 0;
    let close = -1;
    /** @type {number[]} */
    const commas = [];
    for (let i = open + 1; i < item.length; i++) {
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
    if (close < 0) {
      done.push(item);
      continue;
    }
    let from = open + 1;
    for (const end of [...commas, close]) {
      queue.push(item.slice(0, open) + item.slice(from, end) + item.slice(close + 1));
      from = end + 1;
    }
  }
  return [...done, ...queue].slice(0, 64);
}

/**
 * Um segmento de glob casa um nome (sem cruzar `/`), respeitando a regra do ponto inicial.
 * @param {string} glob
 * @param {string} name
 */
function globSegmentMatches(glob, name) {
  if (name.startsWith('.') && !globMatchesLeadingDot(glob)) return false;
  return compileGlob(glob)?.test(name) === true;
}

/**
 * O glob (por segmentos, com `**`) casa o caminho de amostra?
 * @param {string[]} globSegs
 * @param {string[]} nameSegs
 * @returns {boolean}
 */
function pathGlobMatches(globSegs, nameSegs) {
  if (globSegs.length === 0) return nameSegs.length === 0;
  const [g, ...rest] = globSegs;
  if (g === '**') {
    for (let i = 0; i <= nameSegs.length; i++) {
      if (pathGlobMatches(rest, nameSegs.slice(i))) return true;
    }
    return false;
  }
  if (nameSegs.length === 0) return false;
  if (!globSegmentMatches(g ?? '', nameSegs[0] ?? '')) return false;
  return pathGlobMatches(rest, nameSegs.slice(1));
}

/**
 * Um glob de escrita (curinga no nome da pasta .claude, `.claude/se*`, `.claude/{settings,hooks}`)
 * pode alcançar a configuração protegida? Devolve o nível mais forte (deny > ask) entre as
 * amostras que o glob casa, ou `null` se não é glob ou não casa nenhuma.
 * @param {string} rel caminho relativo à raiz, com `/`
 * @returns {'deny' | 'ask' | null}
 */
export function protectedGlobLevel(rel) {
  const p = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!/[*?[{]/.test(p)) return null;
  let best = /** @type {'deny' | 'ask' | null} */ (null);
  for (const expanded of expandBraces(p)) {
    const globSegs = expanded.split('/').filter((s) => s !== '');
    for (const [sample, level] of PROTECTED_SAMPLES) {
      if (pathGlobMatches(globSegs, sample.split('/'))) {
        if (level === 'deny') return 'deny';
        best = 'ask';
      }
    }
  }
  return best;
}

/**
 * Configuração do Claude Code no escopo do USUÁRIO (`~/.claude/settings.json` ou
 * `$CLAUDE_CONFIG_DIR/settings.json`). O Claude Code mescla esse arquivo com o do projeto,
 * então `disableAllHooks` ou hooks/permissions próprios ali desligam o guard-bash e o
 * guard-files. Escrevê-lo por Bash ou código inline é negado; cópia de árvore para dentro do
 * diretório pede confirmação.
 * @param {string} abs caminho ABSOLUTO
 * @returns {'deny' | 'ask' | null}
 */
export function userClaudeConfigLevel(abs) {
  // Lido do ambiente do Claude Code (não é tarefa do turbo: a regra de cache não se aplica).
  const { HOME: home, CLAUDE_CONFIG_DIR: configDir } = process.env;
  const base = configDir ? path.resolve(configDir) : home ? path.join(home, '.claude') : null;
  if (!base) return null;
  const norm = path.resolve(abs);
  if (
    norm === path.join(base, 'settings.json') ||
    norm === path.join(base, 'settings.local.json') ||
    norm === path.join(base, 'cowork_settings.json')
  ) {
    return 'deny';
  }
  if (norm === base || norm.startsWith(`${path.join(base, 'hooks')}${path.sep}`)) return 'ask';
  return null;
}

/**
 * Arquivos de migração: SQL e snapshots gerados pelo drizzle-kit, e o padrão genérico
 * `migrations/`. O diário `_journal.json` é anexado pelo drizzle-kit a cada migração nova
 * e por isso não é tratado como imutável aqui.
 * @param {string} rel caminho relativo à raiz do repositório, com `/`
 * @returns {boolean}
 */
export function isMigrationPath(rel) {
  const p = String(rel).replace(/\\/g, '/');
  if (/(^|\/)drizzle\/meta\/\d+_snapshot\.json$/.test(p)) return true;
  if (/(^|\/)drizzle\/[^/]+\.sql$/.test(p)) return true;
  return /(^|\/)migrations\/.+\.(?:sql|ts|js|mjs|cjs)$/.test(p);
}

/**
 * O último segmento é `environ` ou um glob que casa `environ` (`env*`, `envir?n`, `envi[r]on`).
 * @param {string} seg
 * @returns {boolean}
 */
function segmentMatchesEnviron(seg) {
  if (seg === 'environ') return true;
  if (!/[*?[]/.test(seg)) return false;
  return compileGlob(seg)?.test('environ') === true;
}

/**
 * Caminho que aponta para o `environ` de um processo (`/proc/<pid>/environ`,
 * `/proc/self/task/<tid>/environ`), normalizando `//`, `.` e `..`, aceitando glob, `$VAR` e
 * `self`/`thread-self` no lugar do pid, e glob no último segmento.
 * @param {string} p caminho já com `/`
 * @returns {boolean}
 */
function isProcEnvironPath(p) {
  const norm = path.posix.normalize(p);
  const segments = norm.split('/').filter((s) => s !== '' && s !== '.');
  const at = segments.indexOf('proc');
  if (at < 0) return false;
  let k = at + 1;
  const pid = segments[k];
  const pidOk =
    pid !== undefined &&
    (pid === 'self' ||
      pid === 'thread-self' ||
      /^\d+$/.test(pid) ||
      pid.includes('$') ||
      /[*?[]/.test(pid));
  if (!pidOk) return false;
  k++;
  if (segments[k] === 'task' && segments[k + 1] !== undefined) k += 2;
  const last = segments[k];
  return last !== undefined && k === segments.length - 1 && segmentMatchesEnviron(last);
}
