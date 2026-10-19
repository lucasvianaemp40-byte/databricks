// biome-ignore-all lint/security/noSecrets: as strings são sondas de código de teste, não segredos.
// @ts-check
/**
 * Prova que o lint barra teste desligado (regra 3 do CLAUDE.md: nada de `.skip`, `.todo`,
 * `.only` nem equivalentes). Roda o Biome do repositório com o biome.json e os plugins REAIS
 * (copiados para uma pasta temporária) sobre sondas em caminhos que imitam o monorepo:
 * unitário (Vitest), banco (Vitest), E2E (Playwright) e hooks (node:test).
 *
 * Se uma atualização do Biome mudar o que o noSkippedTests enxerga, este teste mostra a lacuna.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const biomeBin = path.join(repoRoot, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');

/** Categorias que formam o portão de testes desligados. */
const GATE = new Set([
  'lint/suspicious/noSkippedTests',
  'lint/suspicious/noFocusedTests',
  'plugin',
]);

const VITEST = { dir: 'packages/scheduling-core/src/time', ext: '.test.ts' };
const DB = { dir: 'packages/db/test/rls', ext: '.rls.test.ts' };
const E2E = { dir: 'apps/web/e2e', ext: '.spec.ts' };
const NODE_TEST = { dir: '.claude/hooks/test', ext: '.test.mjs' };

/**
 * @typedef {{ name: string, where: { dir: string, ext: string }, code: string }} Probe
 * @type {Probe[]}
 */
const BLOCKED = [
  // Vitest: formas que o noSkippedTests/noFocusedTests do Biome já pegam.
  { name: 'it.skip', where: VITEST, code: "it.skip('caso', () => {});" },
  { name: 'describe.skip', where: VITEST, code: "describe.skip('bloco', () => {});" },
  { name: 'it.concurrent.skip', where: VITEST, code: "it.concurrent.skip('caso', () => {});" },
  { name: 'xit', where: VITEST, code: "xit('caso', () => {});" },
  { name: 'it.only', where: VITEST, code: "it.only('caso', () => {});" },
  // Vitest: formas que só o plugin pega.
  { name: 'it.todo', where: VITEST, code: "it.todo('caso');" },
  { name: 'describe.todo', where: VITEST, code: "describe.todo('bloco');" },
  { name: 'it.skipIf', where: VITEST, code: "it.skipIf(true)('caso', () => {});" },
  { name: 'describe.runIf', where: VITEST, code: "describe.runIf(false)('bloco', () => {});" },
  { name: 'test.fails', where: VITEST, code: "test.fails('caso', () => {});" },
  { name: 'it.skip.prop', where: VITEST, code: "it.skip.prop([fc.nat()])('caso', () => {});" },
  { name: 'test.skip.each', where: VITEST, code: "test.skip.each([[1]])('caso %s', () => {});" },
  { name: 'it.each().skip', where: VITEST, code: "it.each([[1]]).skip('caso %s', () => {});" },
  { name: 'it.each().only', where: VITEST, code: "it.each([[1]]).only('caso %s', () => {});" },
  { name: 'ctx.skip()', where: VITEST, code: "it('caso', (ctx) => { ctx.skip(); });" },
  {
    name: 'ctx.skip(condição)',
    where: VITEST,
    code: "it('caso', (ctx) => { ctx.skip(true, 'motivo'); });",
  },
  { name: 'skip() desestruturado', where: VITEST, code: "it('caso', ({ skip }) => { skip(); });" },
  { name: "it['skip']", where: VITEST, code: "it['skip']('caso', () => {});" },
  { name: 'opção skip', where: VITEST, code: "it('caso', { skip: true }, () => {});" },
  { name: 'opção todo', where: VITEST, code: "it('caso', { todo: true }, () => {});" },
  {
    name: 'opção fails',
    where: VITEST,
    code: "it('caso', { timeout: 1_000, fails: true }, () => {});",
  },
  { name: 'opção only', where: VITEST, code: "it('caso', { only: true }, () => {});" },
  {
    name: 'opção skip no 3º argumento',
    where: VITEST,
    code: "describe('bloco', () => {}, { skip: true });",
  },
  // Banco: o teste negativo cross-tenant é o que mais não pode sumir em silêncio.
  {
    name: 'it.skip no teste de RLS',
    where: DB,
    code: "it.skip('tenant B não lê dado do tenant A', async () => {});",
  },
  {
    name: 'it.todo no teste de RLS',
    where: DB,
    code: "it.todo('tenant B não altera dado do tenant A');",
  },
  // Playwright.
  { name: 'test.skip', where: E2E, code: "test.skip('caso', async () => {});" },
  { name: 'test.describe.skip', where: E2E, code: "test.describe.skip('bloco', () => {});" },
  { name: 'test.fixme', where: E2E, code: "test.fixme('caso', async () => {});" },
  { name: 'test.describe.fixme', where: E2E, code: "test.describe.fixme('bloco', () => {});" },
  { name: 'test.fail', where: E2E, code: "test.fail('caso', async () => {});" },
  { name: 'test.skip() no corpo', where: E2E, code: "test('caso', async () => { test.skip(); });" },
  {
    // Condicional também: só com supressão explícita e motivo (caso aceito abaixo).
    name: 'test.skip(condição, motivo) sem supressão',
    where: E2E,
    code: "test('caso', async ({ isMobile }) => { test.skip(isMobile, 'motivo'); });",
  },
  {
    name: 'test.skip(fixture => condição) no describe',
    where: E2E,
    code: "test.skip(({ isMobile }) => isMobile, 'motivo');",
  },
  {
    name: 'testInfo.skip()',
    where: E2E,
    code: "test('caso', async ({ page: _page }, testInfo) => { testInfo.skip(); });",
  },
  {
    name: 'testInfo.fixme()',
    where: E2E,
    code: "test('caso', async ({ page: _page }, testInfo) => { testInfo.fixme(); });",
  },
  {
    name: 'testInfo.fail()',
    where: E2E,
    code: "test('caso', async ({ page: _page }, testInfo) => { testInfo.fail(); });",
  },
  {
    name: 'test.info().skip()',
    where: E2E,
    code: "test('caso', async () => { test.info().skip(); });",
  },
  // node:test (hooks do Claude Code).
  { name: 'node:test opção skip', where: NODE_TEST, code: "it('caso', { skip: true }, () => {});" },
  {
    name: 'node:test opção todo',
    where: NODE_TEST,
    code: "it('caso', { todo: 'depois' }, () => {});",
  },
  { name: 'node:test t.skip()', where: NODE_TEST, code: "test('caso', (t) => { t.skip('x'); });" },
  { name: 'node:test t.todo()', where: NODE_TEST, code: "test('caso', (t) => { t.todo(); });" },
  { name: 'node:test describe.skip', where: NODE_TEST, code: "describe.skip('bloco', () => {});" },
];

/** @type {Probe[]} */
const ALLOWED = [
  { name: 'teste comum', where: VITEST, code: "it('caso', () => { expect(1).toBe(1); });" },
  {
    name: 'it.each',
    where: VITEST,
    code: "it.each([[1]])('caso %s', (n) => { expect(n).toBe(1); });",
  },
  { name: 'it.prop', where: VITEST, code: "it.prop([fc.nat()])('caso', (n) => n >= 0);" },
  { name: 'opção timeout', where: VITEST, code: "it('caso', { timeout: 10_000 }, () => {});" },
  {
    name: 'objeto comum com chave skip dentro do teste',
    where: VITEST,
    code: "it('caso', () => { const page = { skip: 10, take: 5 }; expect(page.skip).toBe(10); });",
  },
  {
    name: 'assert.fail',
    where: NODE_TEST,
    code: "it('caso', () => { if (Number.NaN === 0) assert.fail('nunca'); });",
  },
  {
    // A saída recomendada para teste que não se aplica a um dispositivo: tag + grepInvert.
    name: 'tag de projeto no Playwright',
    where: E2E,
    code: "test('caso', { tag: '@desktop-only' }, async ({ page }) => { await page.goto('/'); });",
  },
  {
    // Única saída no próprio arquivo: supressão explícita, com motivo, visível na revisão.
    name: 'skip condicional com supressão explícita e motivo',
    where: E2E,
    code: [
      "test('caso', async ({ isMobile }) => {",
      '  // biome-ignore lint/suspicious/noSkippedTests: Tab é de teclado físico (desktop).',
      "  test.skip(isMobile, 'Tab é de teclado físico (desktop).');",
      '});',
    ].join('\n'),
  },
];

/** Código de aplicação: o plugin só olha arquivos de teste. */
const NOT_A_TEST = {
  file: 'packages/db/src/pagination-probe.ts',
  code: 'export const page = (query) => query.skip(10).todo();',
};

/** @type {string} */
let workDir;
/** @type {Map<string, Array<{ category: string, severity: string }>>} */
const diagnosticsByFile = new Map();
/** @type {Map<Probe, string>} */
const fileOf = new Map();

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'salon-biome-gate-'));
  cpSync(path.join(repoRoot, 'biome.json'), path.join(workDir, 'biome.json'));
  cpSync(path.join(repoRoot, 'biome-plugins'), path.join(workDir, 'biome-plugins'), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.mjs'),
  });

  const files = [];
  for (const [index, probe] of [...BLOCKED, ...ALLOWED].entries()) {
    const file = path.join(probe.where.dir, `probe-${String(index)}${probe.where.ext}`);
    fileOf.set(probe, file);
    files.push(file);
  }
  const write = (/** @type {string} */ file, /** @type {string} */ code) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta temporária do teste.
    mkdirSync(path.join(workDir, path.dirname(file)), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- sonda fixa deste arquivo.
    writeFileSync(path.join(workDir, file), `${code}\n`);
  };
  for (const [probe, file] of fileOf) write(file, probe.code);
  write(NOT_A_TEST.file, NOT_A_TEST.code);
  files.push(NOT_A_TEST.file);

  const result = spawnSync(
    process.execPath,
    [
      biomeBin,
      'lint',
      '--vcs-enabled=false',
      '--reporter=json',
      '--max-diagnostics=none',
      ...files,
    ],
    { cwd: workDir, encoding: 'utf8' },
  );
  /** @type {{ diagnostics?: Array<{ category: string, severity: string, location: { path: string } }> }} */
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    assert.fail(`saída do Biome não é JSON (status ${String(result.status)}): ${result.stderr}`);
  }
  for (const diagnostic of report.diagnostics ?? []) {
    const file = path.relative(workDir, path.resolve(workDir, diagnostic.location.path));
    const list = diagnosticsByFile.get(file) ?? [];
    list.push({ category: diagnostic.category, severity: diagnostic.severity });
    diagnosticsByFile.set(file, list);
  }
});

after(() => {
  if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
});

/** @param {string} file */
const gateErrors = (file) =>
  (diagnosticsByFile.get(file) ?? []).filter((d) => GATE.has(d.category) && d.severity === 'error');

describe('lint de testes desligados (regra 3 do CLAUDE.md)', () => {
  for (const probe of BLOCKED) {
    it(`barra ${probe.name} (${probe.where.dir})`, () => {
      const file = fileOf.get(probe) ?? assert.fail('sonda sem arquivo');
      assert.notDeepEqual(gateErrors(file), [], `${probe.code} passou pelo lint`);
    });
  }

  for (const probe of ALLOWED) {
    it(`aceita ${probe.name}`, () => {
      const file = fileOf.get(probe) ?? assert.fail('sonda sem arquivo');
      assert.deepEqual(gateErrors(file), [], `${probe.code} foi barrado sem motivo`);
    });
  }

  it('o plugin não olha código de aplicação', () => {
    const plugin = (diagnosticsByFile.get(NOT_A_TEST.file) ?? []).filter(
      (d) => d.category === 'plugin',
    );
    assert.deepEqual(plugin, []);
  });
});
