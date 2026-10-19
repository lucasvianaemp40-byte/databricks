import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configDefaults } from 'vitest/config';
import type { Reporter } from 'vitest/node';
import NoDisabledTestsReporter from '../../../test-support/vitest-no-disabled-tests-reporter';
import config from '../vitest.config';

// Meta-teste de higiene (regra 3 do CLAUDE.md), irmão do test/test-hygiene.test.ts do
// @salon/scheduling-core. A suíte do banco não pode ser contornada em silêncio. Duas camadas:
// - TEXTO (este arquivo): dica de exclusão de cobertura e teste focado, pulado, pendente ou
//   "esperado falhando" em src/ e test/, por modificador, colchetes, pulo pelo contexto ou
//   chave skip/todo/only no objeto de opções, inclusive sob eslint-disable/biome-ignore. A
//   chave `fails` fica de fora do texto: aqui ela é dado legítimo de tabela de it.each
//   (src/tenant.test.ts); a falha esperada reprova pelo resultado.
// - RESULTADO (test-support/vitest-no-disabled-tests-reporter.ts na raiz, o mesmo do core e do
//   web, provado no meta-teste do core): reprova `pnpm test` e `pnpm test:db` se algum teste
//   terminar pulado, pendente ou com falha esperada, qualquer que seja a sintaxe (opção em
//   variável, spread, pulo computado). Lacunas por desenho, como no core: execução filtrada
//   (-t, arquivo:linha) só conta os testes selecionados, e `--reporter` na linha de comando
//   substitui a lista (por isso os scripts ficam fixos aqui).
// Além disso, todo arquivo de teste roda em exatamente um projeto, e a config fixa .only
// proibido, ordem aleatória, nenhuma nova tentativa, os reporters e as chaves da raiz (nenhum
// filtro como testNamePattern ou tagsFilter). Mudou a config de teste? Isto quebra também.
//
// As expressões usam classes de caractere e as sondas são montadas por partes (`w(...)`)
// para que este arquivo, que também é varrido, não acuse a si mesmo.

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const SCANNED_DIRS = ['src', 'test'] as const;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** Qualquer coisa com cara de arquivo de teste, inclusive extensões que nenhum projeto coleta. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  {
    // Dicas que o Vitest (v8 + ast-v8-to-istanbul) respeita: istanbul, c8, v8 e a do Node.
    label: 'dica de exclusão de cobertura',
    pattern: /\b(?:istanbu[l]|[cv]8|node:coverag[e])\s+(?:ignor[e]|disabl[e])\b/i,
  },
  {
    // it.x, test.concurrent.x, describe.x, it.x.each... (x = modificador proibido)
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
    // Pulo pelo contexto do teste, direto ou desestruturado, e a variante condicional. Pular
    // "quando não há banco" esconderia a suíte de integração inteira: sem TEST_DATABASE_URL o
    // global setup FALHA, nunca pula.
    label: 'pulo em tempo de execução',
    pattern: /\bski[p](?:I[f])?\s*(?:\(|\.\s*i[f]\s*\()/,
  },
  {
    // Chave do objeto de opções que pula, deixa pendente ou foca: com dois pontos (nome, entre
    // aspas ou computada; na chamada, numa variável ou em linha própria) ou abreviada no
    // início ou no fim do objeto. Mesma expressão do core, sem `fails` (ver o cabeçalho).
    // Opção espalhada ou abreviada no meio do objeto fica para o reporter.
    label: 'opção que desliga ou foca teste',
    pattern:
      /(?:^|[{,])\s*\[?\s*['"`]?(?:ski[p]|tod[o]|onl[y])['"`]?\s*\]?\s*:|\{\s*(?:ski[p]|tod[o]|onl[y])\s*[,}]|,\s*(?:ski[p]|tod[o]|onl[y])\s*\}/,
  },
];

function scannedFiles(filter: RegExp): string[] {
  return SCANNED_DIRS.flatMap((dir) =>
    readdirSync(path.join(packageDir, dir), { recursive: true, encoding: 'utf8' })
      .filter((file) => filter.test(file))
      .map((file) => path.posix.join(dir, file.split(path.sep).join('/'))),
  );
}

function readSource(file: string): string {
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

interface ProjectTestConfig {
  readonly name?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

/** Os projetos inline da config, pelo nome (a config não usa projetos por arquivo ou função). */
function projects(): Map<string, ProjectTestConfig & Record<string, unknown>> {
  const byName = new Map<string, ProjectTestConfig & Record<string, unknown>>();
  for (const project of config.test?.projects ?? []) {
    if (typeof project !== 'object' || !('test' in project)) {
      throw new Error('projeto Vitest sem configuração inline');
    }
    const test = project.test as ProjectTestConfig & Record<string, unknown>;
    byName.set(test.name ?? '', test);
  }
  return byName;
}

/** Nomes dos projetos que coletam o arquivo (mesmas regras de include/exclude do Vitest). */
function collectedBy(file: string): string[] {
  return [...projects()].flatMap(([name, project]) => {
    const included = (project.include ?? []).some((glob) => path.matchesGlob(file, glob));
    const excluded = (project.exclude ?? []).some((glob) => path.matchesGlob(file, glob));
    return included && !excluded ? [name] : [];
  });
}

/** Junta pedaços de palavra: as sondas só existem em tempo de execução. */
const w = (...parts: string[]): string => parts.join('');
const SKIP = w('sk', 'ip');
const TODO = w('to', 'do');
const ONLY = w('on', 'ly');
const FAILS = w('fa', 'ils');
const hint = (tool: string, rest: string): string => `/* ${tool} ${w('ign', 'ore')} ${rest} */`;
const call = (...members: string[]): string => `${members.join('.')}('caso', () => {});`;

/** Reporter do portão pelo resultado, compartilhado na raiz; caminho relativo ao pacote. */
const NO_DISABLED_TESTS_REPORTER = '../../test-support/vitest-no-disabled-tests-reporter.ts';
/** O arquivo que o import de NoDisabledTestsReporter acima carrega. */
const SHARED_REPORTER_FILE = fileURLToPath(
  new URL('../../../test-support/vitest-no-disabled-tests-reporter.ts', import.meta.url),
);

describe('higiene da suíte do banco', () => {
  it('deve varrer src/ e test/, inclusive este arquivo', () => {
    const files = scannedFiles(SOURCE_FILE);
    expect(files).toContain('test/test-hygiene.test.ts');
    expect(files).toContain('test/rls/tenant-isolation.rls.test.ts');
    expect(files).toContain('src/tenant.ts');
  });

  it('não deve haver dica de exclusão de cobertura nem teste focado, pulado ou pendente', () => {
    const report = scannedFiles(SOURCE_FILE).flatMap((file) =>
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
    ['pulado com each', call('it', SKIP, 'each([[1]])')],
    ['pulado com concurrent', call('test', 'concurrent', SKIP)],
    ['pulado condicional', call('it', w(SKIP, 'If'))],
    ['pulado condicional em describe', `describe.${w(SKIP, 'If')}(!url)('bloco', () => {});`],
    ['executado condicional', call('test', w('run', 'If'))],
    ['pendente', call('it', w('to', 'do'))],
    ['esperado falhando', call('test', w('fa', 'ils'))],
    ['suite pulada', call('suite', SKIP)],
    ['colchetes', `it[${JSON.stringify(w('on', 'ly'))}]('caso', () => {});`],
    ['contexto', `it('caso', (ctx) => { ctx.${SKIP}(); });`],
    ['contexto desestruturado', `it('caso', ({ ${SKIP} }) => { ${SKIP}(); });`],
    ['opção literal', `it('caso', { ${SKIP}: true }, () => {});`],
    ['opção em describe', `describe('bloco', { ${TODO}: true }, () => {});`],
    [
      'opção em variável (pular sem banco)',
      `const semBanco = { ${SKIP}: process.env['TEST_DATABASE_URL'] === undefined };`,
    ],
    ['opção abreviada', `it('caso', { ${ONLY} }, () => {});`],
    ['opção abreviada no fim', `it('caso', { timeout, ${SKIP} }, () => {});`],
    ['opção entre aspas', `describe('bloco', { '${ONLY}': true }, () => {});`],
    ['opção computada', `it('caso', { ['${SKIP}']: true }, () => {});`],
    ['opção em linha própria', `  ${TODO}: true,`],
  ])('deve detectar %s', (_label, code) => {
    expect(violations(code)).not.toEqual([]);
  });

  it.each([
    [`it('deve rejeitar', async () => {});`],
    [`${w('it.', 'each')}([[1]])('caso %s', () => {});`],
    [`describe('bloco', () => {});`],
    ['const items = list.filter(Boolean); // item.only não é teste'],
    ['// a cobertura v8 do pacote fica para depois'],
    ['await expect(book()).rejects.toThrow();'],
    [`describe('bloco', { timeout: 30_000 }, () => {});`],
    [`// ${TODO} instante em UTC, ${TODO} fuso vem da unidade`],
    // Tabela do it.each de src/tenant.test.ts: `fails` é dado do caso, não opção do Vitest.
    [`      ${FAILS}: (text: string) => text.startsWith('begin'),`],
    [`])('$label', async ({ ${FAILS}, callbackFails, destroyed }) => {`],
  ])('não deve acusar código comum: %s', (code) => {
    expect(violations(code)).toEqual([]);
  });

  it('todo arquivo de teste roda em exatamente um projeto (nenhum fica de fora em silêncio)', () => {
    const files = scannedFiles(TEST_FILE);
    const report = files.flatMap((file) => {
      const owners = collectedBy(file);
      return owners.length === 1
        ? []
        : [`${file}: ${owners.length === 0 ? 'nenhum' : owners.join(', ')}`];
    });
    expect(report).toEqual([]);
    expect(collectedBy('test/test-hygiene.test.ts')).toEqual(['db:unit']);
    expect(collectedBy('src/status-machine-sync.test.ts')).toEqual(['db:unit']);
    expect(collectedBy('test/rls/catalog.rls.test.ts')).toEqual(['db:integration']);
    expect(collectedBy('test/integration/occupancy.int.test.ts')).toEqual(['db:integration']);
    // Sondas: seriam ignoradas pelos dois projetos e precisam ser acusadas acima.
    expect(collectedBy('src/schema/novo.int.test.ts')).toEqual([]);
    expect(collectedBy('test/helpers/fixtures.spec.ts')).toEqual([]);
  });

  it('deve fixar .only proibido, ordem aleatória, nenhuma nova tentativa e os timeouts', () => {
    // .only: sem allowOnly: false o Vitest só o recusa com CI definido (a sessão local não tem).
    // shuffle: a ordem dos testes muda a cada execução (a semente sai no cabeçalho; reproduza com
    // --sequence.seed=<semente>). retry: instabilidade é bug, não se repete até passar.
    // Na raiz, só estas chaves: um filtro (testNamePattern, tagsFilter, exclude...) tiraria
    // teste dos dois projetos sem aparecer no corpo do teste e cegaria o reporter, que trata
    // execução filtrada como lacuna por desenho.
    expect(Object.keys(config.test ?? {}).sort()).toEqual(['projects', 'reporters', 'sequence']);
    expect(config.test?.sequence).toEqual({ shuffle: { files: true, tests: true } });
    expect(Object.fromEntries(projects())).toEqual({
      'db:unit': {
        name: 'db:unit',
        environment: 'node',
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        exclude: ['**/*.int.test.ts', '**/*.rls.test.ts'],
        allowOnly: false,
        retry: 0,
        sequence: { shuffle: true },
      },
      'db:integration': {
        name: 'db:integration',
        environment: 'node',
        include: ['test/**/*.int.test.ts', 'test/**/*.rls.test.ts'],
        globalSetup: ['./test/global-setup.ts'],
        pool: 'forks',
        fileParallelism: false,
        allowOnly: false,
        retry: 0,
        sequence: { shuffle: true },
        testTimeout: 30_000,
        hookTimeout: 120_000,
      },
    });
  });

  it('deve reprovar teste desligado pelo resultado, nos dois projetos, com os scripts fixos', () => {
    // Os reporters padrão do Vitest (inclusive o github-actions no CI) mais o compartilhado, na
    // raiz da config: vale para `db:unit` e para `db:integration`. `--reporter` na linha de
    // comando substituiria esta lista, por isso os dois scripts ficam fixos.
    expect(config.test?.reporters).toEqual([
      ...configDefaults.reporters,
      NO_DISABLED_TESTS_REPORTER,
    ]);
    const packageJson: unknown = JSON.parse(readSource('package.json'));
    expect(packageJson).toMatchObject({
      scripts: {
        test: 'vitest run --project db:unit',
        'test:db': '../../scripts/with-local-postgres.sh vitest run --project db:integration',
      },
    });
  });

  it('o reporter da config é o módulo compartilhado e cumpre o contrato do Vitest', () => {
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
  });
});
