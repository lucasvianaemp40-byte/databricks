// @ts-check
/**
 * Classificação de caminhos sensíveis, compartilhada por guard-bash e guard-files.
 * Mantenha as listas curtas e explícitas: cada entrada é uma decisão de segurança.
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
];

/** Diretórios (segmentos de caminho) que só contêm credenciais. */
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
 * @param {string} base
 * @returns {boolean}
 */
function isSecretBasename(base) {
  if (base.toLowerCase() === ENV_EXAMPLE) return false;
  // Pacotes de certificados de AC são públicos (ex.: ca-bundle.crt, ca-certificates.crt).
  if (/^ca[-_.]?(?:bundle|certificates?)(?:[-_.][\w-]+)?\.(?:crt|pem)$/i.test(base)) return false;
  if (/[*?[]/.test(base)) {
    if (base === '*' || base === '.*' || base === '**') return false;
    let re;
    try {
      re = globToRegExp(base);
    } catch {
      return false;
    }
    return SECRET_SAMPLES.some(
      (sample) => (base.startsWith('.') || !sample.startsWith('.')) && re.test(sample),
    );
  }
  return SECRET_BASENAMES.some((re) => re.test(base));
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
  if (/(^|\/)proc\/[^/]+\/environ$/.test(p)) {
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
 * desligaria a proteção sem passar pela aprovação humana que o Claude Code exige para
 * editar `.claude/` com as ferramentas de arquivo.
 * @param {string} rel caminho relativo à raiz do projeto, com `/`
 * @returns {'deny' | 'ask' | null}
 */
export function protectedConfigLevel(rel) {
  const p = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(p)) return 'deny';
  if (/(^|\/)\.claude\/hooks(\/|$)/.test(p)) return 'deny';
  if (/(^|\/)\.git\/hooks(\/|$)/.test(p)) return 'ask';
  if (/(^|\/)\.git\/config$/.test(p)) return 'ask';
  if (/(^|\/)\.husky(\/|$)/.test(p)) return 'ask';
  if (/(^|\/)lefthook(-local)?\.ya?ml$/.test(p)) return 'ask';
  if (/(^|\/)\.mcp\.json$/.test(p)) return 'ask';
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
