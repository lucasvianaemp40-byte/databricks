import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Meta-teste do portão pelo RESULTADO (regra 3 do CLAUDE.md). O texto (test/test-hygiene) e o
// Biome só veem a sintaxe: opção em variável (`it('x', semBanco, ...)`) ou um biome-ignore
// passam por eles. Aqui o Vitest sobe em processo filho, com o reporter
// test/support/no-disabled-tests-reporter.ts, sobre sondas gravadas numa pasta temporária, e
// a execução precisa reprovar quando algum teste termina pulado, pendente ou com falha
// esperada, qualquer que seja a sintaxe. test/test-hygiene prova que vitest.config.ts usa
// este reporter.
//
// As sondas são montadas por partes (`w(...)`) para que test/test-hygiene, que também varre
// este arquivo, não acuse o próprio meta-teste.

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const REPORTER = path.join(packageDir, 'test', 'support', 'no-disabled-tests-reporter.ts');
const VITEST_CLI = path.join(
  path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);
const HEADER = 'Testes desligados';

const w = (...parts: string[]): string => parts.join('');
const SKIP = w('sk', 'ip');
const TODO = w('to', 'do');
const FAILS = w('fa', 'ils');

/** Cada forma que já escapou do texto e do Biome, mais um teste comum que não pode aparecer. */
const DISABLED_PROBE = [
  `const semBanco = { ${SKIP}: true };`,
  `const conhecido = { ${FAILS}: true };`,
  `describe('opcoes em variavel', () => {`,
  `  it('pulado por variavel', semBanco, () => { expect(1).toBe(2); });`,
  `  it('falha esperada por variavel', conhecido, () => { expect(1).toBe(2); });`,
  `  it('passa ao lado', () => { expect(1).toBe(1); });`,
  '});',
  `describe('suite pulada por variavel', semBanco, () => {`,
  `  it('dentro da suite pulada', () => { expect(1).toBe(2); });`,
  '});',
  '// biome-ignore lint/plugin: sonda',
  `it('pendente por opcao literal', { ${TODO}: true }, () => {});`,
  `it('pulado em tempo de execucao', (ctx) => { ctx.${SKIP}(); expect(1).toBe(2); });`,
  `it('pulo computado', (ctx) => { const pular = ctx.${SKIP}; pular(); expect(1).toBe(2); });`,
  `describe.${TODO}('suite vazia pendente');`,
].join('\n');

const CLEAN_PROBE = [
  `describe('limpo', () => {`,
  `  it('alfa', () => { expect(1).toBe(1); });`,
  `  it('beta', () => { expect(2).toBe(2); });`,
  `  it.each([[1], [2]])('gama %s', (n) => { expect(n).toBeGreaterThan(0); });`,
  '});',
].join('\n');

let probeDir: string;

beforeAll(() => {
  probeDir = mkdtempSync(path.join(tmpdir(), 'salon-core-reporter-'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta temporária criada acima.
  writeFileSync(path.join(probeDir, 'desligados.test.mjs'), DISABLED_PROBE);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta temporária criada acima.
  writeFileSync(path.join(probeDir, 'limpo.test.mjs'), CLEAN_PROBE);
});

afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true });
});

interface ChildRun {
  readonly code: number;
  readonly output: string;
}

/** Roda o Vitest do pacote sobre as sondas, só com o reporter padrão e o portão. */
function runVitest(...args: string[]): Promise<ChildRun> {
  // O filho não herda o estado do worker atual (VITEST_*), nem cor no texto conferido.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('VITEST') && name !== 'FORCE_COLOR',
    ),
  );
  const argv = [
    VITEST_CLI,
    'run',
    '--root',
    probeDir,
    '--globals',
    '--maxWorkers=1',
    '--reporter=default',
    `--reporter=${REPORTER}`,
    ...args,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      argv,
      { cwd: probeDir, env: { ...env, NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`;
        if (error === null) {
          resolve({ code: 0, output });
        } else if (typeof error.code === 'number') {
          resolve({ code: error.code, output });
        } else {
          reject(new Error(`o Vitest filho não terminou: ${output}`, { cause: error }));
        }
      },
    );
  });
}

// Cada caso sobe um processo do Vitest (~0,5 s sozinho, mais com a suíte em paralelo).
describe('reporter que reprova teste desligado', { timeout: 30_000 }, () => {
  it('deve reprovar e listar cada teste pulado, pendente ou com falha esperada', async () => {
    const { code, output } = await runVitest('desligados');

    expect(code).toBe(1);
    expect(output).toContain(HEADER);
    for (const offender of [
      'opcoes em variavel > pulado por variavel',
      'opcoes em variavel > falha esperada por variavel',
      'suite pulada por variavel > dentro da suite pulada',
      'pendente por opcao literal',
      'pulado em tempo de execucao',
      'pulo computado',
      'suite vazia pendente',
    ]) {
      expect(output).toContain(offender);
    }
    expect(output).not.toContain('passa ao lado');
  });

  it('deve aprovar a suíte sem teste desligado', async () => {
    const { code, output } = await runVitest('limpo');

    expect(code).toBe(0);
    expect(output).not.toContain(HEADER);
  });

  it('não deve acusar o que o filtro por nome (-t) deixou de fora', async () => {
    // Reprodução de falha do fast-check: `vitest run <arquivo> -t '<nome do teste>'`.
    const { code, output } = await runVitest('limpo', '-t', 'alfa');

    expect(output).toMatch(/1 passed \| \d+ skipped/);
    expect(code).toBe(0);
    expect(output).not.toContain(HEADER);
  });

  it('deve acusar, em execução filtrada, os testes selecionados que estão desligados', async () => {
    const { code, output } = await runVitest(
      'desligados',
      '-t',
      'esperada|pendente|tempo de execucao',
    );

    expect(code).toBe(1);
    for (const offender of [
      'falha esperada por variavel',
      'pendente por opcao literal',
      'pulado em tempo de execucao',
    ]) {
      expect(output).toContain(offender);
    }
    // Fora do filtro: indistinguível de um pulo declarado, fica para a execução completa.
    expect(output).not.toContain('pulado por variavel');
  });
});
