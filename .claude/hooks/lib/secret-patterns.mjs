// @ts-check
/**
 * Padrões de segredos colados em texto (prompt do usuário). Cada entrada traz um nome
 * legível; a mensagem de bloqueio nunca repete o valor encontrado.
 *
 * Formatos verificados nas documentações dos provedores, exceto os marcados como
 * heurísticos. Prefira falso positivo (o usuário reescreve sem o segredo) a vazamento.
 */

/** @type {Array<{ name: string, re: RegExp }>} */
const SECRET_PATTERNS = [
  {
    name: 'chave privada',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  { name: 'chave de acesso AWS', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/ },
  {
    name: 'segredo AWS',
    re: /\baws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}\b/i,
  },
  {
    name: 'token do GitHub',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
  },
  { name: 'chave da Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'chave da OpenAI', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'chave do Stripe (live)', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/ },
  { name: 'segredo de webhook do Stripe', re: /\bwhsec_[A-Za-z0-9]{24,}/ },
  // Heurístico (formato observado em exemplos públicos; não confirmado na documentação do MP).
  { name: 'token do Mercado Pago', re: /\bAPP_USR-\d{6,}-\d{6}-[a-f0-9]{32}-\d{6,}\b/ },
  { name: 'token do Slack', re: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'chave de API do Google', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'token de acesso da Meta/WhatsApp', re: /\bEAA[A-Za-z0-9]{100,}/ },
  { name: 'token do npm', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'token do Sentry', re: /\bsntr[ysu]_[A-Za-z0-9_=-]{40,}/ },
  { name: 'chave do SendGrid', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  {
    name: 'JWT',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/,
  },
  {
    name: 'cabeçalho Authorization com credencial',
    re: /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{20,}/i,
  },
];

/** Hosts locais: senha de banco de desenvolvimento não é segredo de produção. */
const LOCAL_HOST =
  /^(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$/i;

/**
 * URL com credencial embutida (`esquema://usuario:senha@host`) para host não local.
 * @param {string} text
 * @returns {boolean}
 */
function hasRemoteCredentialUrl(text) {
  const re = /\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s:/@]+):([^\s@/]{3,})@([^\s/:?#]+)/gi;
  for (const m of text.matchAll(re)) {
    const password = m[3] ?? '';
    const host = m[4] ?? '';
    if (/^\$\{?[A-Z_]+\}?$/.test(password) || /^<.*>$/.test(password)) continue;
    if (!LOCAL_HOST.test(host)) return true;
  }
  return false;
}

/**
 * @param {string} text
 * @returns {string | null} nome do tipo de segredo encontrado
 */
export function findSecretInText(text) {
  const value = String(text ?? '');
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(value)) return name;
  }
  if (hasRemoteCredentialUrl(value)) return 'URL com usuário e senha';
  return null;
}
