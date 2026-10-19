// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifySecretPath,
  isLockfile,
  isMigrationPath,
  pathCandidates,
  protectedConfigLevel,
} from '../lib/paths.mjs';

describe('classifySecretPath', () => {
  const secrets = [
    '.env',
    '/repo/apps/web/.env.local',
    'packages/db/.env.test',
    '.ENV.PRODUCTION',
    '.envrc',
    '~/.ssh/id_ed25519',
    '/home/u/.ssh/config',
    '~/.aws/credentials',
    '~/.config/gh/hosts.yml',
    '~/.docker/config.json',
    '~/.kube/config',
    'server.key',
    'certs/tls.pem',
    'keystore.p12',
    'credentials.json',
    'service-account.prod.json',
    'client_secret_123.apps.googleusercontent.com.json',
    '.npmrc',
    '.git-credentials',
    '.pgpass',
    'secrets.yaml',
    'infra/terraform.tfstate',
    '/proc/self/environ',
    '.env*',
    '*.pem',
    '.env.[lp]*',
    '[.]env',
    'cred*.json',
    'secrets.*',
    'service*.json',
    '~/.bash_history',
    '/root/.zsh_history',
    '~/.psql_history',
    '~/.claude.json',
    '/root/.claude/projects/-home-user-x/abc.jsonl',
    '~/.claude/history.jsonl',
    '~/.claude/session-env/abc/hook-0.sh',
    '~/.claude/shell-snapshots/snapshot-bash.sh',
    // /proc/*/environ: glob, task/<tid>, e caminho não normalizado.
    '/proc/self/env*',
    '/proc/self/envi[r]on',
    '/proc/self/task/123/environ',
    '/proc/self/task/*/environ',
    '/proc/self/./environ',
    '/proc//self/environ',
    '/proc/1/task/1/environ',
    '/proc/thread-self/environ',
    '/proc/$$/environ',
  ];
  for (const p of secrets) {
    it(`segredo: ${p}`, () => assert.notEqual(classifySecretPath(p), null));
  }

  const safe = [
    '.env.example',
    'apps/web/.env.example',
    'packages/db/src/env.ts',
    'docs/seguranca/env.md',
    'README.md',
    '~/.docker/daemon.json',
    '/etc/ssl/certs/ca-certificates.crt',
    '/root/.ccr/ca-bundle.crt',
    'id_ed25519.pub',
    'src/keys.ts',
    '/proc/self/status',
    '/proc/self/cmdline',
    '/proc/cpuinfo',
    'environ',
    '*.ts',
    '*',
    '.*',
    '*.json',
    '**/*.json',
    'packages/db/drizzle/meta/*.json',
    '*.{ts,json}',
    '~/.gitconfig',
    '.claude/settings.json',
    '.claude/hooks/guard-bash.mjs',
    '/root/.claude/projects/-home-user-x/memory/MEMORY.md',
  ];
  for (const p of safe) {
    it(`não é segredo: ${p}`, () => assert.equal(classifySecretPath(p), null));
  }

  it('diferencia arquivo de diretório de credenciais', () => {
    assert.equal(classifySecretPath('.env')?.kind, 'file');
    assert.equal(classifySecretPath('~/.ssh')?.kind, 'dir');
    assert.equal(classifySecretPath('/proc/1/environ')?.kind, 'proc');
  });
});

describe('pathCandidates', () => {
  it('extrai caminhos de @arquivo, file://, --opcao=valor e host:caminho', () => {
    assert.deepEqual(pathCandidates('@.env'), ['.env']);
    assert.deepEqual(pathCandidates('file:///repo/.env'), ['/repo/.env']);
    assert.ok(pathCandidates('--env-file=.env').includes('.env'));
    assert.ok(pathCandidates('host:.ssh/id_rsa').includes('.ssh/id_rsa'));
  });
});

describe('isLockfile / protectedConfigLevel / isMigrationPath', () => {
  it('reconhece lockfiles', () => {
    assert.equal(isLockfile('pnpm-lock.yaml'), true);
    assert.equal(isLockfile('/repo/package-lock.json'), true);
    assert.equal(isLockfile('pnpm-workspace.yaml'), false);
  });

  it('classifica configurações protegidas', () => {
    assert.equal(protectedConfigLevel('.claude/settings.json'), 'deny');
    assert.equal(protectedConfigLevel('.claude/settings.local.json'), 'deny');
    assert.equal(protectedConfigLevel('.claude/hooks/guard-bash.mjs'), 'deny');
    assert.equal(protectedConfigLevel('.git/hooks/pre-commit'), 'ask');
    assert.equal(protectedConfigLevel('lefthook.yml'), 'ask');
    assert.equal(protectedConfigLevel('.mcp.json'), 'ask');
    assert.equal(protectedConfigLevel('.claude/skills/verify/SKILL.md'), null);
  });

  it('cobre todas as configurações locais que o lefthook 2 lê', () => {
    for (const p of [
      '.lefthook.yml',
      '.lefthook-local.yml',
      '.lefthook-local.yaml',
      'lefthook-local.json',
      'lefthook-local.jsonc',
      'lefthook-local.toml',
      '.lefthook-local.json',
      'lefthook.toml',
      '.config/lefthook-local.yml',
      '.config/lefthook.yaml',
    ]) {
      assert.equal(protectedConfigLevel(p), 'ask', p);
    }
    assert.equal(protectedConfigLevel('docs/lefthook-notes.md'), null);
  });

  it('protege o wrapper do servidor MCP', () => {
    assert.equal(protectedConfigLevel('.claude/mcp/playwright-mcp.sh'), 'ask');
  });

  it('reconhece migrações do drizzle e pastas migrations/', () => {
    assert.equal(isMigrationPath('packages/db/drizzle/0001_rls.sql'), true);
    assert.equal(isMigrationPath('packages/db/drizzle/meta/0001_snapshot.json'), true);
    assert.equal(isMigrationPath('packages/db/drizzle/meta/_journal.json'), false);
    assert.equal(isMigrationPath('packages/db/migrations/2026/x.ts'), true);
    assert.equal(isMigrationPath('packages/db/src/schema.ts'), false);
  });
});
