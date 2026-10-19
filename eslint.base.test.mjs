// biome-ignore-all lint/security/noSecrets: as strings são sondas de código, não segredos.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: sondas com template literal de propósito.
// @ts-check
/**
 * Prova que as regras gerais da base (eslint.base.mjs) chegam a TODOS os pacotes, inclusive
 * fora do domínio puro: lint de cada pacote com o eslint.config.mjs REAL dele, sobre sondas
 * em caminhos que imitam o código de produção, os testes e os E2E.
 *
 * - Fuso da máquina: `new Date` com data-hora sem Z/offset ('2026-10-17T10:00') e qualquer
 *   `Date.parse` interpretam no fuso do processo (ECMA-262, Date Time String Format). Fora
 *   do domínio puro, `new Date(isoComOffset)`, só data e `new Date()` seguem permitidos.
 * - Cobertura honesta: nenhuma dica de exclusão que o Vitest respeita passa no lint.
 *
 * O @salon/scheduling-core tem regras mais fortes em src/ (test/lint-rules.test.ts do pacote);
 * aqui entra só o test/ dele, que fica fora do domínio puro.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { createBaseConfig, createPureDomainConfig } from './eslint.base.mjs';

const repoRoot = import.meta.dirname;

const FUSO = new Set(['no-restricted-syntax', 'no-restricted-properties']);
const COBERTURA = 'no-warning-comments';

/**
 * Onde as sondas moram: o ESLint 10 resolve a config a partir da pasta de cada arquivo, então
 * cada caminho exercita a config real do pacote (que estende a base).
 */
const PROBE_FILES = [
  'packages/db/src/lint-probe.ts',
  'packages/db/src/cli/lint-probe.ts',
  'packages/db/test/integration/lint-probe.int.test.ts',
  'apps/web/src/lib/lint-probe.ts',
  'apps/web/src/app/lint-probe.tsx',
  'apps/web/e2e/lint-probe.spec.ts',
  'packages/scheduling-core/test/lint-probe.ts',
  'scripts/lint-probe.mjs',
];

/** Declarações neutras para as sondas valerem em TS e em JS sem informação de tipos. */
const PRELUDE = "const day = String('2026-10-17');\nconst iso = String(day);\n";

/** @type {Array<[name: string, code: string, rule: string]>} */
const BLOCKED = [
  ['literal sem offset', "new Date('2026-10-17T10:00');", 'no-restricted-syntax'],
  [
    'literal com segundos, fração e espaço',
    "new Date('2026-10-17 10:00:00.123');",
    'no-restricted-syntax',
  ],
  ['literal com t minúsculo', "new Date('2026-10-17t10:00');", 'no-restricted-syntax'],
  ['literal com ano expandido', "new Date('+002026-10-17T10:00:00');", 'no-restricted-syntax'],
  ['template sem expressão', 'new Date(`2026-10-17T10:00`);', 'no-restricted-syntax'],
  ['template dinâmico', 'new Date(`${day}T10:00`);', 'no-restricted-syntax'],
  ['template dinâmico com segundos', 'new Date(`${day} 10:00:00.5`);', 'no-restricted-syntax'],
  [
    'Date.parse, mesmo com offset',
    "Date.parse('2026-10-17T10:00:00Z');",
    'no-restricted-properties',
  ],
  ['referência a Date.parse', 'export const parse = Date.parse;', 'no-restricted-properties'],
  ['Date.parse desestruturado', 'export const { parse } = Date;', 'no-restricted-properties'],
  ["Date['parse']", "Date['parse'](iso);", 'no-restricted-properties'],
];

/** @type {Array<[name: string, code: string]>} */
const ALLOWED = [
  ['literal com Z', "new Date('2026-10-17T10:00:00Z');"],
  ['literal com offset', "new Date('2026-10-17T10:00:00.000-03:00');"],
  ['literal com offset sem dois-pontos', "new Date('2026-10-17T10:00:00+0000');"],
  ['só data (UTC pela especificação)', "new Date('2026-10-17');"],
  ['template dinâmico com Z', 'new Date(`${day}T10:00:00Z`);'],
  ['template com offset vindo de expressão', 'new Date(`${day}T10:00${iso.slice(10)}`);'],
  ['texto vindo de variável', 'new Date(iso);'],
  ['agora (fora do domínio puro)', 'new Date();'],
  ['Date.now (fora do domínio puro)', 'Date.now();'],
  ['epoch em ms', 'new Date(0);'],
  ['Date.UTC', 'new Date(Date.UTC(2026, 9, 17, 13, 0));'],
  ['comentário comum sobre cobertura', '// cobertura v8 com piso por arquivo\nnew Date(0);'],
];

/**
 * Dica de exclusão de cobertura montada por partes: os meta-testes de higiene dos pacotes e o
 * hook guard-files procuram o texto literal.
 * @param {'block' | 'line' | 'jsdoc'} style
 * @param {string} tool
 * @param {string} rest
 */
function coverageHint(style, tool, rest) {
  const text = `${tool} ${['ign', 'ore'].join('')} ${rest}`.trim();
  if (style === 'line') return `// ${text}\n`;
  if (style === 'jsdoc') return `/** antes ${text} */\n`;
  return `/* ${text} */\n`;
}

/** @type {Array<[style: 'block' | 'line' | 'jsdoc', tool: string, rest: string]>} */
const COVERAGE_HINTS = [
  ['block', 'v8', 'next'],
  ['block', 'v8', 'start -- @preserve'],
  ['line', 'c8', 'next'],
  ['block', 'istanbul', 'else'],
  ['jsdoc', 'v8', 'stop'],
  ['block', ['node', 'coverage'].join(':'), 'next'],
  ['line', ['node', 'coverage'].join(':'), ['dis', 'able'].join('')],
];

/** Um ESLint por pacote, sem informação de tipos: as sondas não existem em disco. */
const eslintByPackage = new Map();

/** @param {string} relativeFile */
function eslintFor(relativeFile) {
  const packageDir = path.join(repoRoot, relativeFile.split('/').slice(0, 2).join('/'));
  const cwd = relativeFile.startsWith('scripts/') ? repoRoot : packageDir;
  let eslint = eslintByPackage.get(cwd);
  if (eslint === undefined) {
    eslint = new ESLint({
      cwd,
      overrideConfig: [
        { files: ['**/*.{ts,tsx,mts,cts}'], ...tseslint.configs.disableTypeChecked },
      ],
    });
    eslintByPackage.set(cwd, eslint);
  }
  return eslint;
}

/**
 * Regras que dispararam na sonda. Erro de parse falha o teste: sonda que não compila não
 * prova nada.
 * @param {string} relativeFile
 * @param {string} code
 */
async function rulesFiredFor(relativeFile, code) {
  const [result] = await eslintFor(relativeFile).lintText(`${PRELUDE}${code}\n`, {
    filePath: path.join(repoRoot, relativeFile),
  });
  assert.ok(result, `sem resultado para ${relativeFile}`);
  const fatal = result.messages.filter((message) => message.fatal === true);
  assert.deepEqual(fatal, [], `sonda inválida em ${relativeFile}`);
  return result.messages.flatMap((message) => message.ruleId ?? []);
}

for (const file of PROBE_FILES) {
  describe(`regras gerais da base em ${file}`, () => {
    for (const [name, code, rule] of BLOCKED) {
      it(`barra ${name}`, async () => {
        const fired = await rulesFiredFor(file, code);
        assert.ok(fired.includes(rule), `${rule} não disparou: ${JSON.stringify(fired)}`);
      });
    }

    for (const [name, code] of ALLOWED) {
      it(`aceita ${name}`, async () => {
        const fired = await rulesFiredFor(file, code);
        const relevant = fired.filter((ruleId) => FUSO.has(ruleId) || ruleId === COBERTURA);
        assert.deepEqual(relevant, []);
      });
    }

    for (const [style, tool, rest] of COVERAGE_HINTS) {
      it(`barra dica de exclusão de cobertura (${style}, ${tool} ${rest})`, async () => {
        const fired = await rulesFiredFor(file, `${coverageHint(style, tool, rest)}new Date(0);`);
        assert.ok(fired.includes(COBERTURA), `${COBERTURA} não disparou: ${JSON.stringify(fired)}`);
      });
    }
  });
}

describe('createPureDomainConfig', () => {
  // Redeclarar no-restricted-syntax SUBSTITUI as opções anteriores: o domínio puro precisa
  // compor as regras de fuso da base, senão um pacote que use só ele as perde.
  const domainFile = 'packages/dominio-sonda/src/lint-probe.ts';
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      ...createBaseConfig({ tsconfigRootDir: repoRoot }),
      ...createPureDomainConfig({ files: ['packages/dominio-sonda/src/**/*.ts'] }),
      { files: ['**/*.ts'], ...tseslint.configs.disableTypeChecked },
    ],
  });

  /** @param {string} code */
  async function domainRulesFiredFor(code) {
    const [result] = await eslint.lintText(`${PRELUDE}${code}\n`, {
      filePath: path.join(repoRoot, domainFile),
    });
    assert.ok(result);
    assert.deepEqual(
      result.messages.filter((message) => message.fatal === true),
      [],
    );
    return result.messages.flatMap((message) => message.ruleId ?? []);
  }

  it('mantém as regras de fuso da base ao lado das de pureza', async () => {
    assert.ok((await domainRulesFiredFor('Date.now();')).includes('no-restricted-syntax'));
    for (const [name, code, rule] of BLOCKED) {
      const fired = await domainRulesFiredFor(code);
      assert.ok(fired.includes(rule), `${name}: ${rule} não disparou: ${JSON.stringify(fired)}`);
    }
  });
});
