// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findSecretInText } from '../lib/secret-patterns.mjs';
import { joinSecret as j, runHook } from '../test-support/helpers.mjs';

// Valores falsos montados em tempo de execução (o código-fonte não contém o segredo inteiro).
/** @param {number} n letras minúsculas e dígitos, determinístico */
const alnum = (n) =>
  Array.from({ length: n }, (_, i) =>
    i % 3 === 2 ? String((i * 7) % 10) : String.fromCharCode(97 + ((i * 11) % 26)),
  ).join('');
/** @param {number} n */
const upper = (n) =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(65 + ((i * 5) % 26))).join('');
/** @param {number} n */
const hex = (n) => Array.from({ length: n }, (_, i) => ((i * 7) % 16).toString(16)).join('');

const SECRETS = /** @type {Array<[string, string]>} */ ([
  ['chave privada', j('-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----\nabc')],
  ['chave de acesso AWS', j('AK', 'IA', upper(16))],
  ['token do GitHub', j('gh', 'p_', alnum(36))],
  ['token do GitHub', j('github', '_pat_', alnum(70))],
  ['chave da Anthropic', j('sk-', 'ant-', 'api03-', alnum(40))],
  ['chave da OpenAI', j('sk-', 'proj-', alnum(48))],
  ['chave do Stripe (live)', j('sk_', 'live_', alnum(24))],
  ['segredo de webhook do Stripe', j('wh', 'sec_', alnum(32))],
  [
    'token do Mercado Pago',
    j('APP_', 'USR-', '1234567', '-', '123456', '-', hex(32), '-', '1234567'),
  ],
  ['token do Slack', j('xo', 'xb-', '1234567890-', alnum(20))],
  ['chave de API do Google', j('AI', 'za', alnum(35))],
  ['token do npm', j('np', 'm_', alnum(36))],
  ['JWT', j('ey', 'J', alnum(20), '.', 'ey', 'J', alnum(24), '.', alnum(30))],
  ['cabeçalho Authorization com credencial', j('Authorization: ', 'Bearer ', alnum(30))],
  ['URL com usuário e senha', j('postgres://app:', 'S3nh4Forte', '@db.prod.example.com:5432/app')],
]);

describe('findSecretInText', () => {
  for (const [kind, value] of SECRETS) {
    it(`detecta ${kind}`, () => {
      assert.equal(findSecretInText(`olha isso: ${value} pode usar?`), kind);
    });
  }

  const benign = [
    'rode pnpm test:db e me diga o que falhou',
    j('DATABASE_URL=postgres://', 'postgres:postgres', '@localhost:5432/salon_test'),
    j('a URL é postgres://app:', '$', '{DB_PASSWORD}', '@db.prod.example.com/app'),
    j('postgres://app:', '<senha>', '@db.example.com/app'),
    'use o token do GitHub que está no secret GH_TOKEN',
    'sk-ant- é o prefixo das chaves da Anthropic',
    j('o hash do commit é ', hex(40)),
  ];
  for (const text of benign) {
    it(`não acusa: ${text.slice(0, 50)}`, () => assert.equal(findSecretInText(text), null));
  }
});

describe('hook guard-prompt.mjs', () => {
  it('bloqueia, suprime o prompt e não repete o segredo', () => {
    const secret = j('gh', 'p_', alnum(36));
    const r = runHook('guard-prompt.mjs', {
      hook_event_name: 'UserPromptSubmit',
      prompt: `meu token: ${secret}`,
    });
    assert.equal(r.status, 0);
    assert.equal(r.json?.decision, 'block');
    assert.equal(r.json?.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    assert.equal(r.json?.hookSpecificOutput?.suppressOriginalPrompt, true);
    assert.ok(!r.stdout.includes(secret), 'a mensagem não pode conter o segredo');
    assert.match(r.json?.reason, /rotacione/);
  });

  it('deixa passar prompt comum sem saída', () => {
    const r = runHook('guard-prompt.mjs', { prompt: 'implemente o cancelamento com 24h' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('erro interno não trava a sessão (exit 1, stderr visível)', () => {
    const r = runHook('guard-prompt.mjs', '{ quebrado');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /guard-prompt/);
    assert.equal(r.stdout.trim(), '');
  });
});
