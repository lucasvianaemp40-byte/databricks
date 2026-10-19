import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PlaywrightTestConfig } from '@playwright/test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { configDefaults } from 'vitest/config';
import type { Reporter } from 'vitest/node';
import NoDisabledTestsReporter from '../../../test-support/vitest-no-disabled-tests-reporter';
import vitestConfig from '../vitest.config';

// Meta-teste de higiene (regra 3 do CLAUDE.md), irmão de
// packages/scheduling-core/test/test-hygiene.test.ts: teste desligado em silêncio é teste
// apagado. Pega o que o lint não pega (ou o que um biome-ignore/eslint-disable esconderia):
// testes focados, pulados, pendentes, "esperados falhando" ou marcados lentos, no Vitest e no
// Playwright, e dicas de exclusão de cobertura. Também fixa as configs que fazem isso valer
// fora do CI. Teste que não se aplica a um projeto do Playwright sai pela config (tag
// @desktop-only, testIgnore), nunca por um pulo condicional no corpo do teste. Como a config
// também pode tirar teste em silêncio, a tabela SPEC_PROJECTS_* fixa em que projeto roda cada
// spec, conferida pela config e pela listagem real do `playwright test --list`.
//
// As expressões usam classes de caractere e as sondas são montadas por partes (`w(...)`)
// para que este arquivo, que também é varrido, não acuse a si mesmo.

const appDir = fileURLToPath(new URL('..', import.meta.url));
const SCANNED_DIRS = ['src', 'e2e'] as const;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  {
    // Dicas que o Vitest (v8 + ast-v8-to-istanbul) respeita: istanbul, c8, v8 e a do Node.
    label: 'dica de exclusão de cobertura',
    pattern: /\b(?:istanbu[l]|[cv]8|node:coverag[e])\s+(?:ignor[e]|disabl[e])\b/i,
  },
  {
    // it.x, test.describe.x, test.concurrent.x, it.x.prop... (x = modificador proibido).
    // fixme/fail/slow são do Playwright; slow triplica o timeout (esconde lentidão).
    label: 'teste focado, pulado, pendente, esperado falhando ou lento',
    pattern:
      /\b(?:i[t]|tes[t]|describ[e]|suit[e]|benc[h])\b[\w\s.]*\.\s*(?:onl[y]|ski[p]|skipI[f]|runI[f]|tod[o]|fail[s]?|fixm[e]|slo[w])\b/,
  },
  {
    label: 'modificador por colchetes',
    pattern:
      /\b(?:i[t]|tes[t]|describ[e]|suit[e])\s*\[\s*['"`](?:onl[y]|ski[p]|skipI[f]|runI[f]|tod[o]|fail[s]?|fixm[e]|slo[w])['"`]\s*\]/,
  },
  {
    // Pulo pelo contexto do teste, direto ou desestruturado, e a variante condicional.
    label: 'pulo em tempo de execução',
    pattern: /\bski[p](?:I[f])?\s*(?:\(|\.\s*i[f]\s*\()/,
  },
  {
    // fixme, fail e slow chamados pelo testInfo ou por test.info() dentro do corpo.
    label: 'pendência, falha esperada ou lentidão em tempo de execução',
    pattern: /\.\s*(?:fixm[e]|fai[l]|slo[w])\s*\(/,
  },
  {
    // Chave do objeto de opções do Vitest que pula, deixa pendente, foca ou espera falha: com
    // dois pontos (nome, entre aspas ou computada; na chamada, numa variável ou em linha
    // própria) ou abreviada no início ou no fim do objeto. Mesma expressão do core. Opção
    // espalhada ou abreviada no meio do objeto fica para o reporter (só no Vitest).
    label: 'opção que desliga ou foca teste',
    pattern:
      /(?:^|[{,])\s*\[?\s*['"`]?(?:ski[p]|tod[o]|fail[s]|onl[y])['"`]?\s*\]?\s*:|\{\s*(?:ski[p]|tod[o]|fail[s]|onl[y])\s*[,}]|,\s*(?:ski[p]|tod[o]|fail[s]|onl[y])\s*\}/,
  },
  {
    // O Playwright aplica a anotação com tipo de modificador como o próprio modificador: um
    // teste com `annotation` de tipo skip ou fixme termina pulado, e com tipo fail conta como
    // aprovado se falhar; o `playwright test` sai com 0 (verificado no 1.64). Os E2E não têm
    // portão pelo resultado: fica no texto.
    label: 'anotação do Playwright que pula, espera falha ou alonga o teste',
    pattern: /\btyp[e]\s*:\s*['"`](?:ski[p]|fixm[e]|fai[l]|slo[w])['"`]/,
  },
];

/**
 * Exceções explícitas, revisadas no PR: arquivo (relativo a apps/web), trecho exato da linha e
 * motivo. Hoje vazia: a exclusão legítima (Tab só no desktop, runtime-env só com build local)
 * está no playwright.config.ts. Entrada que não casa mais com nada reprova (não acumula lixo).
 */
const ALLOWLIST: readonly {
  readonly file: string;
  readonly line: string;
  readonly reason: string;
}[] = [];

function sourceFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pastas fixas do próprio pacote.
    readdirSync(path.join(appDir, dir), { recursive: true, encoding: 'utf8' })
      .filter((file) => SOURCE_FILE.test(file))
      .map((file) => path.join(dir, file)),
  );
}

function readSource(file: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- arquivo listado por sourceFiles().
  return readFileSync(path.join(appDir, file), 'utf8');
}

interface Violation {
  readonly line: number;
  readonly label: string;
  readonly text: string;
}

function violations(source: string): Violation[] {
  const found: Violation[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    for (const { label, pattern } of FORBIDDEN) {
      if (pattern.test(line)) found.push({ line: index + 1, label, text: line.trim() });
    }
  }
  return found;
}

function isAllowed(file: string, { text }: Violation): boolean {
  return ALLOWLIST.some((entry) => entry.file === file && text.includes(entry.line));
}

/** Junta pedaços de palavra: as sondas só existem em tempo de execução. */
const w = (...parts: string[]): string => parts.join('');
const SKIP = w('sk', 'ip');
const TODO = w('to', 'do');
const FAILS = w('fa', 'ils');
const ONLY = w('on', 'ly');
const hint = (tool: string, rest: string): string => `/* ${tool} ${w('ign', 'ore')} ${rest} */`;
const call = (...members: string[]): string => `${members.join('.')}('caso', () => {});`;

describe('higiene da suíte do web', () => {
  it('deve varrer src/ e e2e/, inclusive este arquivo e o suporte dos E2E', () => {
    const files = sourceFiles();
    expect(files).toContain(path.join('src', 'test-hygiene.test.ts'));
    expect(files).toContain(path.join('src', 'proxy.ts'));
    expect(files).toContain(path.join('e2e', 'home.spec.ts'));
    expect(files).toContain(path.join('e2e', 'support', 'fixtures.ts'));
  });

  it('não deve haver dica de exclusão de cobertura nem teste focado, pulado ou pendente', () => {
    const report = sourceFiles().flatMap((file) =>
      violations(readSource(file))
        .filter((violation) => !isAllowed(file, violation))
        .map(({ line, label, text }) => `${file}:${String(line)}: ${label}: ${text}`),
    );
    expect(report).toEqual([]);
  });

  it('cada exceção da allowlist tem motivo e ainda casa com uma linha real', () => {
    const stale = ALLOWLIST.filter(
      (entry) =>
        entry.reason.trim() === '' ||
        !violations(readSource(entry.file)).some(({ text }) => text.includes(entry.line)),
    );
    expect(stale).toEqual([]);
  });

  it.each([
    ['v8 start', hint('v8', 'start')],
    ['c8 next', hint('c8', 'next')],
    ['istanbul if', hint('istanbul', 'if')],
    ['node:coverage desligada', `/* node:coverage ${w('dis', 'able')} */`],
    ['focado', call('it', w('on', 'ly'))],
    ['focado no Playwright', call('test', 'describe', w('on', 'ly'))],
    ['pulado', call('it', SKIP)],
    ['pulado no Playwright', call('test', 'describe', SKIP)],
    ['pulado com prop', call('it', SKIP, 'prop')],
    ['pulado condicional', call('it', w(SKIP, 'If'))],
    ['executado condicional', call('test', w('run', 'If'))],
    ['pendente', call('it', w('to', 'do'))],
    ['esperado falhando no Vitest', call('test', w('fa', 'ils'))],
    ['esperado falhando no Playwright', call('test', w('fa', 'il'))],
    ['fixme no Playwright', call('test', w('fix', 'me'))],
    ['lento no Playwright', `test.${w('sl', 'ow')}();`],
    ['colchetes', `test[${JSON.stringify(w('fix', 'me'))}]('caso', () => {});`],
    ['pulo condicional no corpo', `test.${SKIP}(isMobile, 'motivo');`],
    ['pulo pelo testInfo', `testInfo.${SKIP}(true, 'motivo');`],
    ['pulo por test.info()', `test.info().${SKIP}();`],
    ['fixme pelo testInfo', `testInfo.${w('fix', 'me')}();`],
    ['falha esperada pelo testInfo', `testInfo.${w('fa', 'il')}(true);`],
    ['contexto desestruturado', `it('caso', ({ ${SKIP} }) => { ${SKIP}(); });`],
    ['opção literal', `it('caso', { ${SKIP}: true }, () => {});`],
    ['opção em describe', `describe('bloco', { ${TODO}: true }, () => {});`],
    [
      'opção em variável',
      `const semBuild = { ${SKIP}: process.env['E2E_BASE_URL'] !== undefined };`,
    ],
    ['opção abreviada', `it('caso', { ${FAILS} }, () => {});`],
    ['opção abreviada no fim', `it('caso', { timeout, ${SKIP} }, () => {});`],
    ['opção entre aspas', `describe('bloco', { '${ONLY}': true }, () => {});`],
    ['opção computada', `it('caso', { ['${SKIP}']: true }, () => {});`],
    ['opção em linha própria', `  ${FAILS}: true,`],
    [
      'anotação do Playwright que pula',
      `test('caso', { annotation: { type: '${SKIP}' } }, async () => {});`,
    ],
    ['anotação do Playwright fixme', `const pendencia = { type: "${w('fix', 'me')}" };`],
    [
      'anotação do Playwright de falha esperada',
      `test('caso', { annotation: [{ type: \`${w('fa', 'il')}\` }] }, async () => {});`,
    ],
    ['anotação do Playwright lenta', `annotation: { type: '${w('sl', 'ow')}', description: 'x' },`],
  ])('deve detectar %s', (_label, code) => {
    expect(violations(code)).not.toEqual([]);
  });

  it.each([
    [`test('deve renderizar', async ({ page }) => {});`],
    [`test('só no desktop', { tag: '@desktop-only' }, async ({ page }) => {});`],
    [`${w('it.', 'each')}([[1]])('caso %s', () => {});`],
    [`${w('test.', 'describe')}('bloco', () => {});`],
    [`${w('test.', 'use')}({ allowedConsoleErrors: [] });`],
    ['await new Promise((resolve) => setTimeout(resolve, 250));'],
    ['const items = list.filter(Boolean); // item.only não é teste'],
    ['// o teste falha se aparecer erro no console'],
    [`test('caso', { annotation: { type: 'issue', description: 'x' } }, async () => {});`],
    [`describe('bloco', { timeout: 30_000 }, () => {});`],
    [`// ${TODO} erro de console reprova, ${TODO} spec roda em algum projeto`],
    [`// a tag não aplica opções (${SKIP}, ${TODO}, ${FAILS})`],
  ])('não deve acusar código comum: %s', (code) => {
    expect(violations(code)).toEqual([]);
  });
});

/** Reporter do portão pelo resultado, compartilhado na raiz; caminho relativo ao app. */
const NO_DISABLED_TESTS_REPORTER = '../../test-support/vitest-no-disabled-tests-reporter.ts';
/** O arquivo que o import de NoDisabledTestsReporter acima carrega. */
const SHARED_REPORTER_FILE = fileURLToPath(
  new URL('../../../test-support/vitest-no-disabled-tests-reporter.ts', import.meta.url),
);

describe('config do Vitest (unit)', () => {
  it('recusa .only também fora do CI, embaralha a ordem e não repete teste', () => {
    const test = vitestConfig.test;
    // Só estas chaves: nada de testNamePattern, tagsFilter, exclude ou outra opção que tire
    // teste da execução sem aparecer no corpo do teste (o reporter trataria a execução como
    // filtrada e deixaria de acusar o pulo declarado).
    expect(Object.keys(test ?? {}).sort()).toEqual([
      'allowOnly',
      'environment',
      'include',
      'name',
      'reporters',
      'restoreMocks',
      'sequence',
      'unstubEnvs',
    ]);
    expect(test?.include).toEqual(['src/**/*.test.ts']);
    // Sem isto, o Vitest só recusa .only quando CI está definido (a sessão local não tem).
    expect(test?.allowOnly).toBe(false);
    // Ordem aleatória denuncia dependência entre testes; --sequence.seed=<n> reproduz.
    expect(test?.sequence?.shuffle).toBe(true);
    expect(test?.retry ?? 0).toBe(0);
  });

  it('reprova teste desligado pelo resultado, com o script `test` fixo', () => {
    // Os reporters padrão do Vitest (inclusive o github-actions no CI) mais o compartilhado, que
    // reprova teste pulado, pendente ou com falha esperada, qualquer que seja a sintaxe.
    // `--reporter` na linha de comando substituiria esta lista: o script fica fixo. Vale só
    // para o Vitest: os E2E do Playwright não passam por este portão.
    expect(vitestConfig.test?.reporters).toEqual([
      ...configDefaults.reporters,
      NO_DISABLED_TESTS_REPORTER,
    ]);
    const packageJson: unknown = JSON.parse(readSource('package.json'));
    expect(packageJson).toMatchObject({ scripts: { test: 'vitest run' } });
  });

  it('o reporter da config é o módulo compartilhado e cumpre o contrato do Vitest', () => {
    // A config aponta para o mesmo arquivo que este teste importa (comparar a classe carregada
    // por import dinâmico não serve aqui: o vi.resetModules dos testes do Playwright, em ordem
    // aleatória, faria do módulo outra cópia).
    expect(path.resolve(appDir, NO_DISABLED_TESTS_REPORTER)).toBe(SHARED_REPORTER_FILE);
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

type Project = NonNullable<PlaywrightTestConfig['projects']>[number];
type Patterns = Project['testIgnore'] | Project['grepInvert'];

/** Avalia a config do Playwright com outro ambiente (ela lê process.env ao carregar). */
async function loadPlaywrightConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  // Executável fixo: a config não varre /opt/pw-browsers nem avisa no console.
  vi.stubEnv('E2E_CHROMIUM_EXECUTABLE_PATH', '/nao/existe/chrome');
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  const { default: config } = await import('../playwright.config');
  return config;
}

function project(config: PlaywrightTestConfig, name: string): Project {
  const found = config.projects?.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`projeto ${name} ausente na config do Playwright`);
  return found;
}

/** A config usa só RegExp: string seria glob, avaliada de outro jeito pelo Playwright. */
function matches(patterns: Patterns, subject: string): boolean {
  return [patterns ?? []].flat().some((pattern) => {
    if (!(pattern instanceof RegExp)) throw new Error('use RegExp em testIgnore/grepInvert');
    // Como o Playwright: lastIndex zerado, para uma flag g ou y não deixar o resultado instável.
    pattern.lastIndex = 0;
    return pattern.test(subject);
  });
}

const LOCAL = { CI: undefined, E2E_BASE_URL: undefined };
const REMOTE = { CI: undefined, E2E_BASE_URL: 'https://preview.exemplo.com.br' };
const E2E_DIR = path.join(appDir, 'e2e');
const RUNTIME_ENV_SPEC = path.join(E2E_DIR, 'runtime-env.spec.ts');
const HOME_SPEC = path.join(E2E_DIR, 'home.spec.ts');

type SpecProjects = Record<string, readonly string[]>;

// Em que projeto roda cada spec de e2e/. Spec novo, ou exclusão nova na config, reprova aqui até
// esta tabela mudar no mesmo PR: tirar um spec do e2e vira decisão explícita e revisada, nunca
// efeito colateral de um testIgnore. Com build local, todo spec roda em algum projeto.
const SPEC_PROJECTS_LOCAL: SpecProjects = {
  'a11y.spec.ts': ['chromium', 'mobile'],
  'console-guard.spec.ts': ['chromium'],
  'home.spec.ts': ['chromium', 'mobile'],
  'runtime-env.spec.ts': ['chromium'],
  'security-headers.spec.ts': ['chromium'],
};
// Sem build local (E2E_BASE_URL) não há .next para o runtime-env subir outro `next start`.
const SPEC_PROJECTS_REMOTE: SpecProjects = {
  ...SPEC_PROJECTS_LOCAL,
  'runtime-env.spec.ts': [],
};

// Tudo o que, dentro de um projeto, tira teste da execução sem aparecer no corpo do teste.
const PROJECT_FILTERS = ['testDir', 'testMatch', 'testIgnore', 'grep', 'grepInvert'] as const;

function filtersOf(subject: Project): string[] {
  return PROJECT_FILTERS.filter((key) => subject[key] !== undefined);
}

// Specs que o Playwright coleta (testDir './e2e', testMatch '**/*.spec.ts'), relativos a e2e/.
function specFiles(): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta fixa do próprio pacote.
  return readdirSync(E2E_DIR, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.spec.ts'))
    .map((file) => file.split(path.sep).join('/'))
    .sort();
}

/** Projetos que recebem cada spec pelo testIgnore (o Playwright testa o caminho absoluto). */
function projectsBySpecFromConfig(config: PlaywrightTestConfig): SpecProjects {
  const projects = config.projects ?? [];
  return Object.fromEntries(
    specFiles().map((file) => [
      file,
      projects
        .filter((candidate) => !matches(candidate.testIgnore, path.join(E2E_DIR, file)))
        .map((candidate) => candidate.name ?? '')
        .sort(),
    ]),
  );
}

interface ListedSpec {
  readonly title: string;
  readonly tags: readonly string[];
  readonly tests: readonly { readonly projectName: string }[];
}
interface ListedSuite {
  readonly title: string;
  readonly file: string;
  readonly specs: readonly ListedSpec[];
  readonly suites?: readonly ListedSuite[];
}
/** Um teste listado pelo Playwright num projeto; `file` é relativo a e2e/. */
interface ListedTest {
  readonly project: string;
  readonly file: string;
  readonly title: string;
  readonly tags: readonly string[];
}

const execFileAsync = promisify(execFile);
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve('@playwright/test/cli');

function flattenSuite(suite: ListedSuite, parents: readonly string[]): ListedTest[] {
  return [
    ...suite.specs.flatMap(({ title, tags, tests }) =>
      tests.map(({ projectName }) => ({
        project: projectName,
        file: suite.file,
        title: [...parents, title].join(' › '),
        tags,
      })),
    ),
    ...(suite.suites ?? []).flatMap((child) => flattenSuite(child, [...parents, child.title])),
  ];
}

/**
 * O que o Playwright executaria de fato: `playwright test --list --reporter=json`. Não abre
 * navegador nem sobe o webServer; confere o modelo acima contra o próprio Playwright, inclusive
 * o grepInvert por título e tag, que o testIgnore não mostra.
 */
async function listE2E(env: Record<string, string | undefined>): Promise<ListedTest[]> {
  const { PATH, HOME } = process.env;
  const { stdout } = await execFileAsync(
    process.execPath,
    [PLAYWRIGHT_CLI, 'test', '--config', 'playwright.config.ts', '--list', '--reporter=json'],
    {
      cwd: appDir,
      // Ambiente mínimo: CI, E2E_* e PLAYWRIGHT_JSON_OUTPUT_* da sessão não vazam para cá.
      env: {
        NODE_ENV: 'test',
        PATH,
        HOME,
        E2E_CHROMIUM_EXECUTABLE_PATH: '/nao/existe/chrome',
        ...env,
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const report = JSON.parse(stdout) as {
    readonly suites: readonly ListedSuite[];
    readonly errors: readonly unknown[];
  };
  expect(report.errors).toEqual([]);
  return report.suites.flatMap((fileSuite) => flattenSuite(fileSuite, []));
}

/** Projetos com pelo menos um teste listado, por spec (inclui spec listado fora de specFiles()). */
function projectsBySpecFromListing(listed: readonly ListedTest[]): SpecProjects {
  const files = [...new Set([...specFiles(), ...listed.map(({ file }) => file)])].sort();
  return Object.fromEntries(
    files.map((file) => [
      file,
      [...new Set(listed.filter((test) => test.file === file).map((test) => test.project))].sort(),
    ]),
  );
}

const isDesktopOnly = ({ tags }: ListedTest): boolean =>
  tags.some((tag) => tag.replace(/^@/, '') === 'desktop-only');

/** Títulos completos (describe › teste) de um spec num projeto, na ordem do arquivo. */
function titlesIn(listed: readonly ListedTest[], projectName: string, file: string): string[] {
  return listed
    .filter((test) => test.project === projectName && test.file === file)
    .map(({ title }) => title);
}

describe('config do Playwright', () => {
  it('recusa .only também fora do CI', async () => {
    const config = await loadPlaywrightConfig(LOCAL);
    expect(config.forbidOnly).toBe(true);
  });

  it('o projeto mobile exclui só os testes com a tag @desktop-only', async () => {
    const mobile = project(await loadPlaywrightConfig(LOCAL), 'mobile');
    // O Playwright casa grep/grepInvert com "arquivo describe título @tags".
    expect(matches(mobile.grepInvert, 'home.spec.ts página inicial pular link @desktop-only')).toBe(
      true,
    );
    expect(matches(mobile.grepInvert, 'home.spec.ts página inicial renderiza em pt-BR')).toBe(
      false,
    );
    expect(matches(mobile.grepInvert, 'home.spec.ts desktop-only sem arroba')).toBe(false);
    expect(matches(mobile.grepInvert, 'home.spec.ts caso @desktop-only-extra')).toBe(false);
    expect(matches(mobile.testIgnore, HOME_SPEC)).toBe(false);
  });

  it('o projeto chromium (desktop) não filtra por tag', async () => {
    const chromium = project(await loadPlaywrightConfig(LOCAL), 'chromium');
    expect(chromium.grep).toBeUndefined();
    expect(chromium.grepInvert).toBeUndefined();
  });

  it('com servidor local, runtime-env roda no chromium e fica fora do mobile', async () => {
    const config = await loadPlaywrightConfig(LOCAL);
    expect(config.webServer).toBeDefined();
    expect(matches(project(config, 'chromium').testIgnore, RUNTIME_ENV_SPEC)).toBe(false);
    expect(matches(project(config, 'mobile').testIgnore, RUNTIME_ENV_SPEC)).toBe(true);
  });

  it('com E2E_BASE_URL (sem build local), runtime-env sai de todos os projetos', async () => {
    const config = await loadPlaywrightConfig(REMOTE);
    expect(config.webServer).toBeUndefined();
    for (const { name } of config.projects ?? []) {
      expect(matches(project(config, name ?? '').testIgnore, RUNTIME_ENV_SPEC), name).toBe(true);
      expect(matches(project(config, name ?? '').testIgnore, HOME_SPEC), name).toBe(false);
    }
  });
});

describe('config do Playwright: nenhum spec sai do e2e em silêncio', () => {
  it.each([
    ['com build local', LOCAL],
    ['com E2E_BASE_URL', REMOTE],
  ])('%s, nada filtra fora dos projetos', async (_label, env) => {
    const config = await loadPlaywrightConfig(env);
    expect(config.testDir).toBe('./e2e');
    expect(config.testMatch).toBe('**/*.spec.ts');
    // Na raiz, estes valeriam para todos os projetos de uma vez.
    expect(config.testIgnore).toBeUndefined();
    expect(config.grep).toBeUndefined();
    expect(config.grepInvert).toBeUndefined();
    expect(config.shard).toBeUndefined();
  });

  it.each([
    ['com build local', LOCAL, { chromium: [], mobile: ['testIgnore', 'grepInvert'] }],
    [
      'com E2E_BASE_URL',
      REMOTE,
      { chromium: ['testIgnore'], mobile: ['testIgnore', 'grepInvert'] },
    ],
  ])('%s, cada projeto usa só os filtros previstos', async (_label, env, expected) => {
    const config = await loadPlaywrightConfig(env);
    const filters = Object.fromEntries(
      (config.projects ?? []).map((candidate): [string, string[]] => [
        candidate.name ?? '',
        filtersOf(candidate),
      ]),
    );
    expect(filters).toEqual(expected);
  });

  it('com build local, a tabela põe todo spec em pelo menos um projeto', () => {
    const orphans = Object.entries(SPEC_PROJECTS_LOCAL)
      .filter(([, projects]) => projects.length === 0)
      .map(([file]) => file);
    expect(orphans).toEqual([]);
  });

  it.each([
    ['com build local', LOCAL, SPEC_PROJECTS_LOCAL],
    ['com E2E_BASE_URL', REMOTE, SPEC_PROJECTS_REMOTE],
  ])('%s, o testIgnore dos projetos bate com a tabela de specs', async (_label, env, expected) => {
    expect(projectsBySpecFromConfig(await loadPlaywrightConfig(env))).toEqual(expected);
  });
});

describe('config do Playwright: listagem real (playwright test --list)', () => {
  let local: ListedTest[] = [];
  let remote: ListedTest[] = [];

  beforeAll(async () => {
    [local, remote] = await Promise.all([listE2E(LOCAL), listE2E(REMOTE)]);
  });

  it.each([
    ['com build local', () => local, SPEC_PROJECTS_LOCAL],
    ['com E2E_BASE_URL', () => remote, SPEC_PROJECTS_REMOTE],
  ])('%s, o Playwright lista cada spec nos projetos da tabela', (_label, listed, expected) => {
    expect(projectsBySpecFromListing(listed())).toEqual(expected);
  });

  it.each([
    ['com build local', () => local, SPEC_PROJECTS_LOCAL],
    ['com E2E_BASE_URL', () => remote, SPEC_PROJECTS_REMOTE],
  ])(
    '%s, o mobile recebe os testes do chromium menos os @desktop-only',
    (_label, listed, specs) => {
      const shared = Object.entries(specs)
        .filter(([, projects]) => projects.includes('chromium') && projects.includes('mobile'))
        .map(([file]) => file);
      const tests = listed();
      const notDesktopOnly = tests.filter((test) => !isDesktopOnly(test));
      expect(
        Object.fromEntries(shared.map((file) => [file, titlesIn(tests, 'mobile', file)])),
      ).toEqual(
        Object.fromEntries(
          shared.map((file) => [file, titlesIn(notDesktopOnly, 'chromium', file)]),
        ),
      );
    },
  );
});
