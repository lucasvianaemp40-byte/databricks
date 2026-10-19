// @ts-check
/**
 * O guard-files só vê o caminho e o glob explícitos de uma chamada. Numa busca em diretório
 * (Grep sem glob, ou com `*`, `.*`), quem exclui os segredos é a camada nativa: o Claude Code
 * transforma cada regra `Read(...)` de `permissions.deny` em `rg --iglob '!<padrão>'`. Este
 * teste garante que as duas camadas não divergem: todo tipo de segredo que o hook conhece tem
 * uma regra nativa equivalente em `.claude/settings.json`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifySecretPath } from '../lib/paths.mjs';

const SETTINGS = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'settings.json');

/** @returns {string[]} */
function readDenyRules() {
  const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  /** @type {string[]} */
  const deny = settings?.permissions?.deny ?? [];
  return deny
    .map((rule) => /^Read\((.+)\)$/.exec(rule)?.[1])
    .filter((p) => typeof p === 'string' && !p.startsWith('!'))
    .map(String);
}

/**
 * Glob no estilo gitignore usado pelas regras de permissão (`**`, `*`, `?`).
 * @param {string} glob
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {string} rule padrão de uma regra Read(...)
 * @param {string} sample caminho relativo ao projeto ou começando com `~/`
 */
function ruleCovers(rule, sample) {
  if (rule.startsWith('//')) return false;
  if (sample.startsWith('~/')) {
    if (!rule.startsWith('~/')) return false;
    return globToRegExp(rule.slice(2)).test(sample.slice(2));
  }
  if (rule.startsWith('~/')) return false;
  const rel = rule.replace(/^\.?\//, '');
  const re = globToRegExp(rel.includes('/') ? rel : `**/${rel}`);
  return re.test(sample);
}

const PROJECT_SAMPLES = [
  '.env',
  'apps/web/.env.local',
  '.envrc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'certs/server.key',
  'certs/cert.pem',
  'keystore.p12',
  'store.pfx',
  'app.jks',
  'app.keystore',
  'chave.ppk',
  'AuthKey_X.p8',
  'cofre.kdbx',
  'credentials.json',
  'service-account.json',
  'client_secret_123.json',
  '.npmrc',
  '.git-credentials',
  '.netrc',
  '.pgpass',
  '.pypirc',
  '.yarnrc.yml',
  '.my.cnf',
  '.credentials.json',
  'secrets.json',
  'config/secret.yaml',
  'infra/terraform.tfstate',
  'infra/terraform.tfstate.backup',
  'x/.ssh/config',
  'x/.aws/credentials',
  'x/.gnupg/pubring.kbx',
  'x/.kube/config',
  'x/.azure/accessTokens.json',
  'x/.docker/config.json',
  'x/.config/gh/hosts.yml',
  'x/.config/gcloud/credentials.db',
  'secrets/db.txt',
];

const HOME_SAMPLES = [
  '~/.ssh/id_ed25519',
  '~/.aws/credentials',
  '~/.config/gh/hosts.yml',
  '~/.git-credentials',
  '~/.npmrc',
  '~/.claude/.credentials.json',
  '~/.bash_history',
  '~/.zsh_history',
  '~/.claude.json',
  '~/.claude/history.jsonl',
  '~/.claude/projects/-home-user-x/abc.jsonl',
  '~/.claude/session-env/abc/hook-0.sh',
];

describe('regras nativas Read(...) de permissions.deny acompanham o guard-files', () => {
  const rules = readDenyRules();
  for (const sample of [...PROJECT_SAMPLES, ...HOME_SAMPLES]) {
    it(`segredo coberto pelas duas camadas: ${sample}`, () => {
      assert.notEqual(classifySecretPath(sample), null, 'o hook não classifica como segredo');
      assert.ok(
        rules.some((rule) => ruleCovers(rule, sample)),
        `nenhuma regra Read(...) em permissions.deny cobre ${sample}`,
      );
    });
  }

  it('a memória automática do Claude Code continua legível', () => {
    const memory = '~/.claude/projects/-home-user-x/memory/MEMORY.md';
    assert.equal(classifySecretPath(memory), null);
    assert.ok(!rules.some((rule) => ruleCovers(rule, memory)));
  });
});
