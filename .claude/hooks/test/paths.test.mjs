// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifySecretPath,
  dotGlobReachesSecret,
  expandGlobBraces,
  isLockfile,
  isMigrationPath,
  pathCandidates,
  protectedConfigLevel,
  protectedGlobLevel,
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

describe('expandGlobBraces', () => {
  it('expande listas, aninhamento e alternativa vazia', () => {
    assert.deepEqual(expandGlobBraces('{a,b}.ts'), {
      expansions: ['a.ts', 'b.ts'],
      unresolved: [],
    });
    assert.deepEqual(expandGlobBraces('.env{,.local}').expansions, ['.env', '.env.local']);
    assert.deepEqual(expandGlobBraces('{x,{1..2}}').expansions.sort(), ['1', '1..2', '2', 'x']);
  });

  it('expande sequência numérica e de letra e mantém o literal (o globset do Grep não expande)', () => {
    assert.deepEqual(expandGlobBraces('f{1..3}').expansions.sort(), ['f1', 'f1..3', 'f2', 'f3']);
    assert.ok(expandGlobBraces('.e{n..n}v').expansions.includes('.env'));
    assert.ok(expandGlobBraces('{a..p}em').expansions.includes('a..pem'));
  });

  it('chave depois de uma sem fechamento ainda é expandida', () => {
    assert.ok(
      expandGlobBraces('x{/.claude/{settings.json,y}').expansions.includes(
        'x{/.claude/settings.json',
      ),
    );
  });

  it('acima do teto não trunca em silêncio: devolve o prefixo do que não expandiu', () => {
    const big = expandGlobBraces(`.claude/${'{a,b}'.repeat(7)}`);
    assert.ok(big.unresolved.length > 0);
    assert.ok(big.unresolved.every((prefix) => prefix.startsWith('.claude/')));
    assert.ok(big.expansions.length <= 64, `gerou ${big.expansions.length}`);
    assert.deepEqual(expandGlobBraces('x/{1..1000}').unresolved, ['x/']);
  });
});

describe('protectedGlobLevel: sequência, teto e tamanho (fail-closed)', () => {
  const cases = /** @type {Array<[string, 'deny' | 'ask' | null]>} */ ([
    ['.c{l..l}aude/settings.json', 'deny'],
    ['.claude/se{s..u}tings.json', 'deny'],
    ['.claude/{settings,x}.json', 'deny'],
    // Acima do teto: nega se o prefixo está sob .claude/; nos outros casos, pede confirmação.
    ['.claude/{1..100}', 'deny'],
    ['{.claude,x}/{1..1000}', 'deny'],
    ['.c*/{1..1000}', 'deny'],
    [`.claude/${'{a,b}'.repeat(7)}`, 'deny'],
    ['x/{1..1000}', 'ask'],
    ['.claude{1..1000}', 'ask'],
    [`src/${'{a,b}'.repeat(7)}`, 'ask'],
    // Glob que casa o próprio diretório protegido.
    ['.claude/h*', 'deny'],
    ['.claude/m*', 'ask'],
    ['.git/h*', 'ask'],
    ['.hus*', 'ask'],
    // Glob grande demais para avaliar: mesma regra do prefixo.
    [`.claude/${'[a-z]'.repeat(300)}`, 'deny'],
    [`src/${'[a-z]'.repeat(300)}`, 'ask'],
    // Globs normais continuam iguais.
    ['src/{a,b}.ts', null],
    ['src/{1..3}.ts', null],
    ['docs/{a..c}/*.md', null],
    ['apps/web/src/app/[slug]/page.tsx', null],
    ['.claude/skills/*/SKILL.md', null],
  ]);
  for (const [glob, expected] of cases) {
    it(`${String(expected).padEnd(4)} ${glob.length > 60 ? `${glob.slice(0, 60)}…` : glob}`, () => {
      assert.equal(protectedGlobLevel(glob), expected);
    });
  }
});

describe('globs: tamanho e ReDoS', () => {
  it('glob com milhares de * depois de .env continua sendo segredo (o limite não falha aberto)', () => {
    assert.notEqual(classifySecretPath(`.env${'*'.repeat(5000)}`), null);
  });

  it('glob longo demais para avaliar é tratado como segredo se pode casar um', () => {
    assert.notEqual(classifySecretPath(`.e[${'n'.repeat(300)}]x`), null);
  });

  it('código inline longo com [ ] não vira segredo (não casa nome curto nenhum)', () => {
    const code = `import json; print([k for k in d]); ${'x = [1, 2, 3]; '.repeat(30)}`;
    assert.equal(classifySecretPath(code), null);
  });

  it('colapsar * e ? mantém o resultado dos globs normais', () => {
    assert.notEqual(classifySecretPath('.env**'), null);
    assert.notEqual(classifySecretPath('*.p*?m'), null);
    assert.notEqual(classifySecretPath('.e?*?'), null);
    assert.equal(classifySecretPath('**.json'), null);
    assert.equal(dotGlobReachesSecret('.??*'), true);
    assert.equal(protectedGlobLevel('.claude/se**ings.json'), 'deny');
  });

  it('muitos * seguidos não travam a classificação', () => {
    const started = performance.now();
    assert.equal(classifySecretPath(`${'*'.repeat(13)}x`), null);
    assert.equal(classifySecretPath(`${'*?'.repeat(13)}x`), null);
    assert.equal(dotGlobReachesSecret(`.${'*'.repeat(13)}x`), false);
    assert.equal(protectedGlobLevel(`.claude/${'*'.repeat(13)}x`), null);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `levou ${elapsed.toFixed(0)} ms`);
  });
});
