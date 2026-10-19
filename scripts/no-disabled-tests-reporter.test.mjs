// @ts-check
/**
 * Prova do portão pelo RESULTADO das suítes node:test da raiz e dos hooks (regra 3 do
 * CLAUDE.md). O Biome só vê a sintaxe, e um biome-ignore ou uma opção em variável passam por
 * ele; o `node --test` sai com 0 mesmo com testes pulados ou pendentes. O reporter
 * scripts/no-disabled-tests-reporter.mjs reprova a execução quando algum teste ou suíte
 * termina pulado ou pendente, qualquer que seja a sintaxe.
 *
 * Aqui o `node --test` sobe em processo filho, com as MESMAS opções de reporter que o
 * package.json usa em `test:root` e `test:hooks`, sobre sondas gravadas numa pasta temporária.
 * As sondas são texto: o lint deste arquivo não as vê como testes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const repoRoot = path.join(import.meta.dirname, '..');
const HEADER = 'Testes desligados';

/** Opções de reporter exigidas nos dois scripts: o spec de sempre e o portão. */
const REPORTER_OPTIONS = [
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=./scripts/no-disabled-tests-reporter.mjs',
  '--test-reporter-destination=stderr',
];

/** Cada forma de desligar um teste no node:test, ao lado de testes comuns. */
const DISABLED_PROBE = `import { describe, it, test } from 'node:test';
const semRede = { skip: 'sem rede' };
describe('bloco', () => {
  // biome-ignore lint/suspicious/noSkippedTests: sonda
  it.skip('modificador skip', () => {});
  it('opcao skip literal', { skip: true }, () => {});
  it('opcao skip em variavel', semRede, () => {});
  it('passa ao lado', () => {});
});
describe.skip('suite pulada', () => {
  it('dentro da suite pulada', () => {});
});
describe('suite pulada por opcao', semRede, () => {
  it('dentro da suite por opcao', () => {});
});
test('pulo em execucao', (t) => {
  t.skip('motivo');
});
it.todo('pendente sem corpo');
test('pendente que falha', { todo: true }, () => {
  throw new Error('falha escondida');
});
test('pendente em execucao', (t) => {
  t.todo();
});
describe.todo('suite pendente', () => {
  it('dentro da suite pendente', () => {});
});
test('pai comum', async (t) => {
  await t.test('subteste pulado', { skip: true }, () => {});
  await t.test('subteste comum', () => {});
});
`;

const DISABLED_NAMES = [
  'modificador skip',
  'opcao skip literal',
  'opcao skip em variavel',
  'suite pulada',
  'suite pulada por opcao',
  'pulo em execucao',
  'pendente sem corpo',
  'pendente que falha',
  'pendente em execucao',
  'suite pendente',
  'dentro da suite pendente',
  'subteste pulado',
];

const ENABLED_NAMES = ['passa ao lado', 'pai comum', 'subteste comum'];

/** Testes comuns, inclusive opções falsas e pulo condicional que não acontece. */
const CLEAN_PROBE = `import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
describe('limpo', () => {
  it('alfa', () => {
    assert.equal(1, 1);
  });
  it('opcao desligada', { skip: false, todo: false }, () => {});
});
test('pulo condicional que nao acontece', (t) => {
  if (process.env.SALON_NUNCA_DEFINIDA === 'sim') t.skip();
});
`;

/** @type {string} */
let probeDir;

before(() => {
  probeDir = mkdtempSync(path.join(tmpdir(), 'salon-node-test-reporter-'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta temporária criada acima.
  writeFileSync(path.join(probeDir, 'desligados.test.mjs'), DISABLED_PROBE);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta temporária criada acima.
  writeFileSync(path.join(probeDir, 'limpo.test.mjs'), CLEAN_PROBE);
});

after(() => {
  rmSync(probeDir, { recursive: true, force: true });
});

/**
 * Roda `node --test` na raiz do repositório (o reporter é resolvido a partir dela, como no
 * `pnpm`) com as opções de reporter dos scripts. Sem NODE_TEST_CONTEXT, o filho seria tratado
 * como um arquivo deste runner e não usaria os reporters.
 * @param {string[]} files
 * @param {string[]} [extra]
 */
function runNodeTest(files, extra = []) {
  /** @type {NodeJS.ProcessEnv} */
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== 'NODE_TEST_CONTEXT' && name !== 'FORCE_COLOR',
    ),
  );
  env.NO_COLOR = '1';
  const result = spawnSync(
    process.execPath,
    ['--test', ...REPORTER_OPTIONS, ...extra, ...files.map((file) => path.join(probeDir, file))],
    { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Lista do portão (stderr) a partir do cabeçalho, para não confundir com avisos do Node. */
function offenderList(/** @type {string} */ stderr) {
  const start = stderr.indexOf(HEADER);
  return start === -1 ? '' : stderr.slice(start);
}

describe('no-disabled-tests-reporter (portão do node:test)', () => {
  it('test:root e test:hooks usam o spec e o portão, sem outra opção do runner', () => {
    /** @type {{ scripts: Record<string, string | undefined> }} */
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    for (const name of ['test:root', 'test:hooks']) {
      const script = pkg.scripts[name];
      assert.ok(typeof script === 'string', `script ${name} ausente`);
      const tokens = script.trim().split(/\s+/);
      assert.deepEqual(tokens.slice(0, 2), ['node', '--test'], name);
      // Opção de filtro (--test-skip-pattern, --test-name-pattern, --test-only) esconderia
      // testes do portão: o node:test não reporta o que o filtro deixou de fora.
      const options = tokens.filter((token) => token.startsWith('-'));
      assert.deepEqual(options, ['--test', ...REPORTER_OPTIONS], name);
    }
  });

  it('reprova (exit 1) e lista cada teste ou suíte pulado ou pendente, e só eles', () => {
    const r = runNodeTest(['desligados.test.mjs']);
    assert.equal(r.status, 1, r.stderr);
    const list = offenderList(r.stderr);
    assert.notEqual(list, '', `sem a lista do portão no stderr:\n${r.stderr}`);
    assert.match(list, /desligados\.test\.mjs:\d+:\d+/);
    for (const name of DISABLED_NAMES) {
      assert.ok(list.includes(`> ${name} [`), `${name} fora da lista:\n${list}`);
    }
    for (const name of ENABLED_NAMES) {
      assert.ok(!list.includes(`> ${name} [`), `${name} acusado sem motivo:\n${list}`);
    }
    assert.match(list, /> opcao skip em variavel \[pulado: sem rede\]/);
    assert.match(list, /> pendente que falha \[pendente\]/);
    assert.match(list, /> suite pulada \[suíte pulada\]/);
    assert.match(list, /> suite pendente \[suíte pendente\]/);
    assert.ok(list.includes(`${HEADER} (${String(DISABLED_NAMES.length)})`), list);
  });

  it('suíte limpa passa (exit 0), sem a lista e com a saída do spec no stdout', () => {
    const r = runNodeTest(['limpo.test.mjs']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(offenderList(r.stderr), '');
    assert.match(r.stdout, /alfa/);
    assert.match(r.stdout, /pass 3/);
  });

  it('um arquivo desligado reprova a execução inteira, mesmo com outro limpo', () => {
    const r = runNodeTest(['limpo.test.mjs', 'desligados.test.mjs']);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(!offenderList(r.stderr).includes('limpo.test.mjs'), r.stderr);
  });

  it('execução filtrada (--test-name-pattern) só conta o que foi selecionado', () => {
    const comum = runNodeTest(['desligados.test.mjs'], ['--test-name-pattern=passa ao lado']);
    assert.equal(comum.status, 0, comum.stderr);
    const pulado = runNodeTest(['desligados.test.mjs'], ['--test-name-pattern=opcao skip literal']);
    assert.equal(pulado.status, 1, pulado.stderr);
    assert.match(offenderList(pulado.stderr), /> opcao skip literal \[pulado\]/);
  });
});
