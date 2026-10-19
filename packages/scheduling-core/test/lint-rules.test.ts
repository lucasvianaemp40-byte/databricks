import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// Meta-teste: prova que as regras de pureza do domínio (eslint.config.mjs do pacote +
// eslint.base.mjs da raiz) disparam de verdade. Se alguém afrouxar a config, isto quebra.

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const DOMAIN_RULES = new Set([
  'no-restricted-syntax',
  'no-restricted-properties',
  'no-restricted-globals',
  '@typescript-eslint/no-restricted-imports',
]);

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({
    cwd: packageDir,
    // O arquivo de sonda não existe em disco: sem informação de tipos. As regras de domínio
    // são sintáticas e não dependem dela.
    overrideConfig: [{ files: ['**/*.ts'], ...tseslint.configs.disableTypeChecked }],
  });
});

async function domainRulesFiredFor(code: string, relativePath = 'src/lint-probe.ts') {
  const [result] = await eslint.lintText(code, { filePath: path.join(packageDir, relativePath) });
  return (result?.messages ?? [])
    .map((message) => message.ruleId)
    .filter((ruleId): ruleId is string => ruleId !== null && DOMAIN_RULES.has(ruleId));
}

describe('regras de lint do domínio puro', () => {
  it.each([
    [
      'Date.now()',
      'export const t = Date.now();',
      ['no-restricted-syntax', 'no-restricted-properties'],
    ],
    ['referência a Date.now', 'export const f = Date.now;', ['no-restricted-properties']],
    ['new Date() sem argumentos', 'export const d = new Date();', ['no-restricted-syntax']],
    ['new Date(x) com argumento', 'export const d = new Date(0);', ['no-restricted-syntax']],
    [
      'Date.parse (fuso da máquina)',
      "export const t = Date.parse('2026-11-03T09:00');",
      ['no-restricted-syntax', 'no-restricted-properties'],
    ],
    // Redeclarar no-restricted-properties no pacote SUBSTITUI a regra da base (eslint.base.mjs,
    // bloco salon/fuso-da-maquina): sem a composição, referência e desestruturação passariam.
    ['referência a Date.parse', 'export const p = Date.parse;', ['no-restricted-properties']],
    ['Date.parse desestruturado', 'export const { parse } = Date;', ['no-restricted-properties']],
    [
      'Math.random()',
      'export const r = Math.random();',
      ['no-restricted-syntax', 'no-restricted-properties'],
    ],
    [
      'Temporal.Now',
      "import { Temporal } from 'temporal-polyfill';\nexport const t = Temporal.Now.instant();",
      ['no-restricted-syntax', 'no-restricted-properties'],
    ],
    [
      'performance.now()',
      'export const t = performance.now();',
      ['no-restricted-syntax', 'no-restricted-properties'],
    ],
    ['Temporal global', 'export const T = globalThis.Temporal;', ['no-restricted-properties']],
    [
      'toLocaleString (fuso/idioma da máquina)',
      "import { Temporal } from 'temporal-polyfill';\nexport const s = Temporal.Instant.from('2026-11-03T12:00:00Z').toLocaleString();",
      ['no-restricted-syntax'],
    ],
    ['crypto.randomUUID()', 'export const id = crypto.randomUUID();', ['no-restricted-syntax']],
    ['process (I/O e ambiente)', 'export const tz = process.env.TZ;', ['no-restricted-globals']],
    ['setTimeout', 'setTimeout(() => undefined, 1);', ['no-restricted-globals']],
    [
      'módulo do Node',
      "export { readFileSync } from 'node:fs';",
      ['@typescript-eslint/no-restricted-imports'],
    ],
    [
      'polyfill global',
      "import 'temporal-polyfill/global';",
      ['@typescript-eslint/no-restricted-imports'],
    ],
  ])('deve barrar %s em src/', async (_label, code, expectedRules) => {
    const fired = await domainRulesFiredFor(code);
    expect([...new Set(fired)].sort()).toEqual([...expectedRules].sort());
  });

  it('deve aceitar código que recebe o tempo por Clock e usa Temporal com fuso explícito', async () => {
    const code = [
      "import { Temporal } from 'temporal-polyfill';",
      'export interface Clock { now(): Temporal.Instant }',
      'export const label = (clock: Clock, timeZone: string): string =>',
      "  clock.now().toZonedDateTimeISO(timeZone).toPlainTime().toString({ smallestUnit: 'minute' });",
    ].join('\n');
    expect(await domainRulesFiredFor(code)).toEqual([]);
  });

  it('não deve aplicar as regras de domínio ao suporte de testes em test/', async () => {
    expect(await domainRulesFiredFor('export const t = Date.now();', 'test/probe.ts')).toEqual([]);
  });
});

describe('regra contra dica de exclusão de cobertura', () => {
  // Montada por partes: test/test-hygiene.test.ts varre este arquivo também.
  const hint = (style: 'block' | 'line' | 'jsdoc', tool: string, rest: string): string => {
    const text = `${tool} ${['ign', 'ore'].join('')} ${rest}`;
    const comment =
      style === 'line'
        ? `// ${text}`
        : style === 'jsdoc'
          ? `/** antes ${text} */`
          : `/* ${text} */`;
    return `${comment}\nexport const x = 1;\n`;
  };

  async function rulesFiredFor(code: string, relativePath: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, {
      filePath: path.join(packageDir, relativePath),
    });
    return (result?.messages ?? []).flatMap((message) => message.ruleId ?? []);
  }

  it.each([
    ['block', 'v8', 'start'],
    ['block', 'v8', 'next -- @preserve'],
    ['line', 'c8', 'next'],
    ['block', 'istanbul', 'else'],
    ['block', 'node:coverage', 'next'],
    ['jsdoc', 'v8', 'stop'],
  ] as const)('deve barrar comentário %s com %s %s em src/ e test/', async (style, tool, rest) => {
    for (const file of ['src/lint-probe.ts', 'test/probe.ts']) {
      expect(await rulesFiredFor(hint(style, tool, rest), file)).toContain('no-warning-comments');
    }
  });

  it('não deve barrar comentário comum sobre cobertura', async () => {
    const code = '// cobertura v8 com piso por arquivo\nexport const x = 1;\n';
    expect(await rulesFiredFor(code, 'src/lint-probe.ts')).not.toContain('no-warning-comments');
  });
});
