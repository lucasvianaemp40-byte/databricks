// @ts-check
/**
 * Classificação de caminhos sensíveis, compartilhada por guard-bash e guard-files.
 * Mantenha as listas curtas e explícitas: cada entrada é uma decisão de segurança.
 * Toda família de segredo daqui precisa de uma regra `Read(...)` equivalente em
 * `permissions.deny` do `.claude/settings.json` (test/settings-deny.test.mjs confere).
 */
import path from 'node:path';
import { braceSequenceTerms } from './shell.mjs';

/** Único arquivo .env* que o agente pode ler e editar (modelo sem valores reais). */
const ENV_EXAMPLE = '.env.example';

/** Teto de alternativas na expansão de chaves (`{a,b}`, `{1..9}`); acima dele, fail-closed. */
const MAX_BRACE_EXPANSIONS = 64;
/**
 * Maior glob de um nome (segmento) avaliado por expressão regular, já com `*` e `?` colapsados.
 * Acima disso o glob não é avaliado e quem chama trata como "pode casar" (fail-closed).
 */
const MAX_GLOB_SEGMENT_LENGTH = 256;
/** Maior caminho com glob que `protectedGlobLevel` avalia; acima disso, fail-closed. */
const MAX_GLOB_PATH_LENGTH = 1024;

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
 * Junta cada sequência de `*` e `?` (`**`, `*?*`) num equivalente com um `*` só (`*`, `?*`).
 * Casa os mesmos nomes e evita o backtracking polinomial de `.*.*.*` na expressão regular.
 * Dentro de `[...]` o conjunto de caracteres da classe também não muda.
 * @param {string} glob
 */
export function collapseWildcards(glob) {
  return glob.replace(/[*?]{2,}/g, (run) => {
    const singles = run.replaceAll('*', '');
    return run.includes('*') ? `${singles}*` : singles;
  });
}

/**
 * Menor tamanho de nome que o glob casa: `*` vale 0; `?`, classe e literal valem 1. É exato:
 * nome mais curto que isso não casa, sem precisar avaliar a expressão regular.
 * @param {string} glob
 */
function globMinLength(glob) {
  let n = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === '*') continue;
    if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end !== -1) i = end;
    }
    n++;
  }
  return n;
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
 * @typedef {object} GlobMatcher
 * @property {RegExp | null} re `null` quando o glob passa de MAX_GLOB_SEGMENT_LENGTH: não é
 *   avaliado, e `globMayMatch` responde "pode casar" (fail-closed)
 * @property {number} minLength menor tamanho de nome que o glob casa
 */

/**
 * O nome pode casar o glob? Exato quando há expressão regular; sem ela (glob longo demais),
 * responde `true` sempre que o tamanho do nome permite.
 * @param {GlobMatcher} matcher
 * @param {string} name
 */
function globMayMatch(matcher, name) {
  if (name.length < matcher.minLength) return false;
  return matcher.re === null || matcher.re.test(name);
}

/**
 * @param {GlobMatcher} matcher
 * @param {string} glob
 * @param {string[]} samples
 */
function globHits(matcher, glob, samples) {
  const dot = globMatchesLeadingDot(glob);
  return samples.some(
    (sample) => (dot || !sample.startsWith('.')) && globMayMatch(matcher, sample),
  );
}

/**
 * @param {string} glob
 * @returns {GlobMatcher | null} `null` quando a classe é inválida (`[z-a]`)
 */
function compileGlob(glob) {
  const collapsed = collapseWildcards(glob);
  const minLength = globMinLength(collapsed);
  if (collapsed.length > MAX_GLOB_SEGMENT_LENGTH) return { re: null, minLength };
  try {
    return { re: globToRegExp(collapsed), minLength };
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
    const matcher = compileGlob(base);
    if (!matcher) return false;
    // Glob longo demais para avaliar: segredo se o tamanho permite casar um (fail-closed); o
    // filtro dos nomes comuns não se aplica, porque ele também não dá para avaliar.
    if (matcher.re === null) return globHits(matcher, base, SECRET_SAMPLES);
    return globHits(matcher, base, SECRET_SAMPLES) && !globHits(matcher, base, BENIGN_SAMPLES);
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
  const matcher = compileGlob(base);
  return matcher !== null && globHits(matcher, base, SECRET_SAMPLES);
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
  if (p === '' || p.includes('\n')) return null;
  // Caminho literal acima de PATH_MAX não abre; um glob tão longo ainda expande para nome curto
  // (`.env` seguido de milhares de `*`), então continua avaliado.
  if (p.length > 4096 && !/[*?[]/.test(p)) return null;
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
  // Os diretórios protegidos também: `mv .claude/h* /tmp/` leva a pasta inteira.
  ['.claude/hooks', 'deny'],
  ['.claude/mcp', 'ask'],
  ['.git/hooks', 'ask'],
  ['.husky', 'ask'],
]);

/**
 * Primeiro grupo de chaves de um glob, com as alternativas. Lista com vírgula (inclusive
 * aninhada e com alternativa vazia); grupo sem vírgula vira a própria alternativa (`{x}` -> `x`,
 * como no globset do Grep); sequência do bash (`{1..3}`) traz os termos e também o texto
 * literal (`1..3`), que é o que o globset casa. `parts: null` quando a sequência passa de `max`.
 * Chave sem fechamento é literal, e a busca segue para a próxima.
 * @param {string} item
 * @param {number} max
 * @returns {{ open: number, close: number, parts: string[] | null } | null}
 */
function findGlobBraceGroup(item, max) {
  for (let open = item.indexOf('{'); open >= 0; open = item.indexOf('{', open + 1)) {
    let depth = 0;
    /** @type {number[]} */
    const commas = [];
    for (let i = open + 1; i < item.length; i++) {
      const ch = item.charAt(i);
      if (ch === '{') depth++;
      else if (ch === ',' && depth === 0) commas.push(i);
      else if (ch === '}' && depth > 0) depth--;
      else if (ch === '}') {
        const content = item.slice(open + 1, i);
        if (commas.length === 0) {
          const terms = braceSequenceTerms(content, max);
          if (terms === null) return { open, close: i, parts: null };
          return { open, close: i, parts: [content, ...(terms ?? [])] };
        }
        /** @type {string[]} */
        const parts = [];
        let from = open + 1;
        for (const end of [...commas, i]) {
          parts.push(item.slice(from, end));
          from = end + 1;
        }
        return { open, close: i, parts };
      }
    }
  }
  return null;
}

/**
 * Expande as chaves de um glob (`{a,b}`, `.env{,.local}`, `{1..3}`, `{a..c}`) sem truncar: o
 * que não dá para expandir inteiro (sequência ou produto acima de `max` alternativas) vai para
 * `unresolved` como o prefixo antes da chave, para quem chama decidir (fail-closed). A ordem
 * das expansões não é a do bash; o conjunto é um superconjunto do que o bash e o globset geram.
 * @param {string} glob
 * @param {number} [max]
 * @returns {{ expansions: string[], unresolved: string[] }}
 */
export function expandGlobBraces(glob, max = MAX_BRACE_EXPANSIONS) {
  /** @type {string[]} */
  const expansions = [];
  /** @type {Set<string>} */
  const unresolved = new Set();
  const queue = [glob];
  while (queue.length > 0) {
    const item = /** @type {string} */ (queue.shift());
    const group = findGlobBraceGroup(item, max);
    if (!group) {
      expansions.push(item);
      continue;
    }
    const prefix = item.slice(0, group.open);
    if (group.parts === null || expansions.length + queue.length + group.parts.length > max) {
      unresolved.add(prefix);
      continue;
    }
    const suffix = item.slice(group.close + 1);
    for (const part of group.parts) queue.push(prefix + part + suffix);
  }
  return { expansions, unresolved: [...unresolved] };
}

/**
 * Um segmento de glob casa um nome (sem cruzar `/`), respeitando a regra do ponto inicial.
 * Glob longo demais para avaliar casa todo nome de tamanho compatível (fail-closed).
 * @param {string} glob
 * @param {string} name
 */
function globSegmentMatches(glob, name) {
  if (name.startsWith('.') && !globMatchesLeadingDot(glob)) return false;
  const matcher = compileGlob(glob);
  return matcher !== null && globMayMatch(matcher, name);
}

/**
 * Nível de um glob cujas chaves passam do teto, a partir do prefixo já conhecido: `deny` se ele está sob `.claude/` (algum segmento
 * completo casa `.claude`), `ask` nos outros casos.
 * @param {string} prefix
 * @returns {'deny' | 'ask'}
 */
function unresolvedGlobLevel(prefix) {
  const complete = prefix
    .split('/')
    .slice(0, -1)
    .filter((s) => s !== '' && s !== '.');
  return complete.some((seg) => globSegmentMatches(seg, '.claude')) ? 'deny' : 'ask';
}

/**
 * Nível de um caminho com glob longo demais para avaliar inteiro: cada segmento, literal ou com
 * curinga, é comparado com `.claude` até o primeiro que não dá para avaliar (chaves, classe
 * inválida). Segmento longo demais para virar expressão regular conta como "pode casar" quando o
 * tamanho permite. `deny` se algum pode casar; sem decisão, `deny` quando o primeiro segmento
 * não vazio tem curinga (ele mesmo pode ser a pasta .claude) e `ask` nos outros casos.
 * @param {string} p
 * @returns {'deny' | 'ask'}
 */
function longGlobLevel(p) {
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  for (const seg of segments) {
    if (seg.includes('{') || compileGlob(seg) === null) {
      return /[*?[{]/.test(segments[0] ?? '') ? 'deny' : 'ask';
    }
    if (globSegmentMatches(seg, '.claude')) return 'deny';
  }
  return 'ask';
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
  return protectedGlobMatch(rel)?.level ?? null;
}

/**
 * Como `protectedGlobLevel`, e diz de onde veio o nível: `unresolved: false` quando o glob
 * alcança uma amostra protegida; `unresolved: true` quando o glob (ou parte dele) não deu
 * para avaliar inteiro (chaves acima do teto, caminho longo demais) e o nível saiu só do
 * prefixo conhecido (fail-closed). Quem chama usa isso para dar o motivo certo.
 * @param {string} rel caminho relativo à raiz, com `/`
 * @returns {{ level: 'deny' | 'ask', unresolved: boolean } | null}
 */
export function protectedGlobMatch(rel) {
  const p = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!/[*?[{]/.test(p)) return null;
  if (p.length > MAX_GLOB_PATH_LENGTH) {
    return { level: longGlobLevel(p), unresolved: true };
  }
  const { expansions, unresolved } = expandGlobBraces(p);
  let sampleAsk = false;
  for (const expanded of expansions) {
    const globSegs = expanded.split('/').filter((s) => s !== '');
    for (const [sample, level] of PROTECTED_SAMPLES) {
      if (pathGlobMatches(globSegs, sample.split('/'))) {
        if (level === 'deny') return { level: 'deny', unresolved: false };
        sampleAsk = true;
      }
    }
  }
  let unresolvedAsk = false;
  for (const prefix of unresolved) {
    if (unresolvedGlobLevel(prefix) === 'deny') return { level: 'deny', unresolved: true };
    unresolvedAsk = true;
  }
  if (sampleAsk) return { level: 'ask', unresolved: false };
  return unresolvedAsk ? { level: 'ask', unresolved: true } : null;
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
  const matcher = compileGlob(seg);
  return matcher !== null && globMayMatch(matcher, 'environ');
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
