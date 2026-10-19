import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configDefaults } from 'vitest/config';
import type { Reporter } from 'vitest/node';
import NoDisabledTestsReporter from '../../../test-support/vitest-no-disabled-tests-reporter';
import config from '../vitest.config';
import CoreReporterEntry from './support/no-disabled-tests-reporter';

// Meta-teste de higiene (regra 3 do CLAUDE.md): o piso de cobertura por arquivo e a suíte
// inteira não podem ser contornados em silêncio. Duas camadas:
// - TEXTO (este arquivo): dicas de exclusão de cobertura e testes focados, pulados,
//   pendentes ou "esperados falhando" escritos por modificador, colchetes, pulo pelo
//   contexto ou chave no objeto de opções, inclusive sob eslint-disable/biome-ignore.
// - RESULTADO (test-support/vitest-no-disabled-tests-reporter.ts na raiz, o mesmo do
//   @salon/db e do @salon/web, provado em test/no-disabled-tests-reporter.test.ts): o texto
//   não vê opção espalhada nem pulo computado; o reporter reprova a execução se algum teste
//   terminar pulado, pendente ou com falha esperada, qualquer que seja a sintaxe. Este
//   arquivo fixa o reporter na config, o script `test` e as chaves da config (um filtro como
//   testNamePattern ou tagsFilter na config cegaria o reporter, que trata execução filtrada
//   como lacuna por desenho).
// Mudou a config de teste? Isto quebra também.
//
// As expressões usam classes de caractere e as sondas são montadas por partes (`w(...)`)
// para que este arquivo, que também é varrido, não acuse a si mesmo.

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const SCANNED_DIRS = ['src', 'test'] as const;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  {
    // Dicas que o Vitest (v8 + ast-v8-to-istanbul) respeita: istanbul, c8, v8 e a do Node.
    label: 'dica de exclusão de cobertura',
    pattern: /\b(?:istanbu[l]|[cv]8|node:coverag[e])\s+(?:ignor[e]|disabl[e])\b/i,
  },
  {
    // it.x, test.concurrent.x, describe.x, it.x.prop... (x = modificador proibido)
    label: 'teste focado, pulado, pendente ou esperado falhando',
    pattern:
      /\b(?:i[t]|tes[t]|describ[e]|suit[e]|benc[h])\b[\w\s.]*\.\s*(?:onl[y]|ski[p]|skipI[f]|runI[f]|tod[o]|fail[s])\b/,
  },
  {
    label: 'modificador por colchetes',
    pattern:
      /\b(?:i[t]|tes[t]|describ[e]|suit[e])\s*\[\s*['"`](?:onl[y]|ski[p]|skipI[f]|runI[f]|tod[o]|fail[s])['"`]\s*\]/,
  },
  {
    // Pulo pelo contexto do teste, direto ou desestruturado, e a variante condicional.
    label: 'pulo em tempo de execução',
    pattern: /\bski[p](?:I[f])?\s*(?:\(|\.\s*i[f]\s*\()/,
  },
  {
    // Chave do objeto de opções que pula, deixa pendente, foca ou espera falha: com dois
    // pontos (nome, entre aspas ou computada; na chamada, numa variável ou em linha própria)
    // ou abreviada no início ou no fim do objeto. Prosa ("todo horário", listas com vírgula)
    // não casa. Opção espalhada ou abreviada no meio do objeto fica para o reporter.
    label: 'opção que desliga ou foca teste',
    pattern:
      /(?:^|[{,])\s*\[?\s*['"`]?(?:ski[p]|tod[o]|fail[s]|onl[y])['"`]?\s*\]?\s*:|\{\s*(?:ski[p]|tod[o]|fail[s]|onl[y])\s*[,}]|,\s*(?:ski[p]|tod[o]|fail[s]|onl[y])\s*\}/,
  },
];

function sourceFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pastas fixas do próprio pacote.
    readdirSync(path.join(packageDir, dir), { recursive: true, encoding: 'utf8' })
      .filter((file) => SOURCE_FILE.test(file))
      .map((file) => path.join(dir, file)),
  );
}

function readSource(file: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- arquivo listado por sourceFiles().
  return readFileSync(path.join(packageDir, file), 'utf8');
}

function violations(text: string): string[] {
  const found: string[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const { label, pattern } of FORBIDDEN) {
      if (pattern.test(line)) found.push(`${String(index + 1)}: ${label}: ${line.trim()}`);
    }
  }
  return found;
}

/** Junta pedaços de palavra: as sondas só existem em tempo de execução. */
const w = (...parts: string[]): string => parts.join('');
const SKIP = w('sk', 'ip');
const TODO = w('to', 'do');
const FAILS = w('fa', 'ils');
const ONLY = w('on', 'ly');
const hint = (tool: string, rest: string): string => `/* ${tool} ${w('ign', 'ore')} ${rest} */`;
const call = (...members: string[]): string => `${members.join('.')}('caso', () => {});`;

/** Reporter do portão pelo resultado, compartilhado na raiz; caminho relativo ao pacote. */
const NO_DISABLED_TESTS_REPORTER = '../../test-support/vitest-no-disabled-tests-reporter.ts';
/** O arquivo que o import de NoDisabledTestsReporter acima carrega. */
const SHARED_REPORTER_FILE = fileURLToPath(
  new URL('../../../test-support/vitest-no-disabled-tests-reporter.ts', import.meta.url),
);

describe('higiene da suíte do domínio', () => {
  it('deve varrer src/ e test/, inclusive este arquivo', () => {
    const files = sourceFiles();
    expect(files).toContain(path.join('test', 'test-hygiene.test.ts'));
    expect(files).toContain(path.join('src', 'availability', 'compute-available-slots.ts'));
  });

  it('não deve haver dica de exclusão de cobertura nem teste focado, pulado ou pendente', () => {
    const report = sourceFiles().flatMap((file) =>
      violations(readSource(file)).map((violation) => `${file}:${violation}`),
    );
    expect(report).toEqual([]);
  });

  it.each([
    ['v8 start', hint('v8', 'start')],
    ['v8 next com @preserve', hint('v8', 'next -- @preserve')],
    ['c8 next', hint('c8', 'next')],
    ['istanbul if', hint('istanbul', 'if')],
    ['node:coverage next', hint('node:coverage', 'next')],
    ['node:coverage desligada', `/* node:coverage ${w('dis', 'able')} */`],
    ['focado', call('it', w('on', 'ly'))],
    ['focado em describe', call('describe', w('on', 'ly'))],
    ['pulado', call('it', SKIP)],
    ['pulado com prop', call('it', SKIP, 'prop')],
    ['pulado com concurrent', call('test', 'concurrent', SKIP)],
    ['pulado condicional', call('it', w(SKIP, 'If'))],
    ['executado condicional', call('test', w('run', 'If'))],
    ['pendente', call('it', w('to', 'do'))],
    ['esperado falhando', call('test', w('fa', 'ils'))],
    ['suite pulada', call('suite', SKIP)],
    ['colchetes', `it[${JSON.stringify(w('on', 'ly'))}]('caso', () => {});`],
    ['contexto', `it('caso', (ctx) => { ctx.${SKIP}(); });`],
    ['contexto desestruturado', `it('caso', ({ ${SKIP} }) => { ${SKIP}(); });`],
    ['opção literal', `it('caso', { ${SKIP}: true }, () => {});`],
    ['opção em describe', `describe('bloco', { ${TODO}: true }, () => {});`],
    ['opção em variável', `const semBanco = { ${SKIP}: process.env['X'] === undefined };`],
    ['opção abreviada', `it('caso', { ${FAILS} }, () => {});`],
    ['opção abreviada no fim', `it('caso', { timeout, ${SKIP} }, () => {});`],
    ['opção entre aspas', `describe('bloco', { '${ONLY}': true }, () => {});`],
    ['opção computada', `it('caso', { ['${SKIP}']: true }, () => {});`],
    ['opção em linha própria', `  ${FAILS}: true,`],
  ])('deve detectar %s', (_label, code) => {
    expect(violations(code)).not.toEqual([]);
  });

  it.each([
    [`it('deve calcular', () => {});`],
    [`${w('it.', 'each')}([[1]])('caso %s', () => {});`],
    [`${w('it.', 'prop')}([fc.nat()])('propriedade', () => {});`],
    [`describe('bloco', { tags: ['property'] }, () => {});`],
    [`describe('bloco', { timeout: 30_000 }, () => {});`],
    [`'P1: ${TODO} horário deve caber inteiro na jornada do seu dia local',`],
    [`// o fuso ${TODO} vem da unidade, ${TODO} instante em UTC`],
    [`// a tag não aplica opções (${SKIP}, ${TODO}, ${FAILS}, retry)`],
    ['const items = list.filter(Boolean); // item.only não é teste'],
    ['// usa a cobertura v8 com piso por arquivo'],
  ])('não deve acusar código comum: %s', (code) => {
    expect(violations(code)).toEqual([]);
  });

  it('deve manter o piso de cobertura por arquivo, a suíte inteira e o .only proibido', () => {
    const test = config.test;
    // Só estas chaves: nada de testNamePattern, tagsFilter, exclude ou outra opção que tire
    // teste da execução sem aparecer no corpo do teste (o reporter trataria a execução como
    // filtrada e deixaria de acusar o pulo declarado).
    expect(Object.keys(test ?? {}).sort()).toEqual([
      'allowOnly',
      'coverage',
      'environment',
      'include',
      'name',
      'reporters',
      'retry',
      'sequence',
      'setupFiles',
      'tags',
    ]);
    expect(test?.include).toEqual(['src/**/*.test.ts', 'test/**/*.test.ts']);
    expect(test?.retry).toBe(0);
    // Sem isto, o Vitest só recusa .only quando CI está definido (a sessão local não tem).
    expect(test?.allowOnly).toBe(false);
    // Ordem aleatória de arquivos e testes: dependência de ordem ou estado compartilhado
    // aparece como falha (o Vitest imprime a semente; reproduza com --sequence.seed=<semente>).
    expect(test?.sequence?.shuffle).toBe(true);
    // Portão pelo resultado: os reporters padrão do Vitest (inclusive o github-actions no CI)
    // mais o compartilhado, que reprova teste pulado, pendente ou com falha esperada, qualquer
    // que seja a sintaxe. `--reporter` na linha de comando substitui esta lista: o script fica
    // fixo.
    expect(test?.reporters).toEqual([...configDefaults.reporters, NO_DISABLED_TESTS_REPORTER]);
    const packageJson: unknown = JSON.parse(readSource('package.json'));
    expect(packageJson).toMatchObject({ scripts: { test: 'vitest run --coverage' } });
    // Tag aplica opções de teste a quem a usa (pulo, pendência, falha esperada, retry): aqui
    // ela só tem nome, descrição e timeout.
    for (const tag of test?.tags ?? []) {
      expect(Object.keys(tag).sort()).toEqual(['description', 'name', 'timeout']);
    }
    expect(test?.tags?.map(({ name, timeout }) => ({ name, timeout }))).toEqual([
      { name: 'property', timeout: 180_000 },
    ]);
    expect(test?.coverage).toEqual({
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95, perFile: true },
    });
  });

  it('o reporter da config é o módulo compartilhado, e o atalho do meta-teste também', () => {
    // A config aponta para o mesmo arquivo que este teste importa.
    expect(path.resolve(packageDir, NO_DISABLED_TESTS_REPORTER)).toBe(SHARED_REPORTER_FILE);
    // Tipo conferido pelo tsc deste pacote: a classe declara só o subconjunto da API que lê e
    // precisa ser um Reporter da versão instalada do Vitest. Como todo gancho do Reporter é
    // opcional, um gancho renomeado ainda compilaria: a checagem em tempo de execução dos três
    // ganchos que o portão usa, desestruturados do tipo Reporter, pega isso.
    const reporter: Reporter = new NoDisabledTestsReporter();
    const { onInit, onTestRunStart, onTestRunEnd } = reporter;
    expect([onInit, onTestRunStart, onTestRunEnd]).toEqual([
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    ]);
    // test/no-disabled-tests-reporter.test.ts sobe o Vitest com o atalho do core: se ele virar
    // uma cópia, o meta-teste passaria a provar outro código, não o da config.
    expect(CoreReporterEntry).toBe(NoDisabledTestsReporter);
  });
});
