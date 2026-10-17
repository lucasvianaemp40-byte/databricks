// @ts-check
/**
 * Configuração ESLint 10 (flat) compartilhada do monorepo.
 *
 * Divisão de trabalho: o Biome formata e faz o lint geral (rápido, roda no pre-commit).
 * O ESLint fica enxuto e cobre só o que o Biome não cobre:
 *   - regras que dependem de tipos (typescript-eslint strictTypeChecked);
 *   - segurança (eslint-plugin-security);
 *   - regras de domínio (pureza do @salon/scheduling-core: relógio, aleatoriedade e I/O).
 *
 * Uso em um pacote (eslint.config.mjs):
 *   import { defineConfig } from 'eslint/config';
 *   import { createBaseConfig } from '../../eslint.base.mjs';
 *   export default defineConfig(createBaseConfig({ tsconfigRootDir: import.meta.dirname }));
 */
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import security from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Artefatos gerados: nunca são lintados. */
export const generatedIgnores = globalIgnores(
  [
    '**/node_modules/',
    '**/.next/',
    '**/out/',
    '**/dist/',
    '**/coverage/',
    '**/.turbo/',
    '**/.vitest/',
    '**/playwright-report/',
    '**/blob-report/',
    '**/test-results/',
    '**/next-env.d.ts',
  ],
  'salon/ignores-gerados',
);

/** Arquivos de teste (unit, propriedade, banco e Playwright). */
export const testFiles = [
  '**/*.{test,spec}.{ts,tsx,mts}',
  '**/test/**/*.{ts,tsx,mts}',
  '**/e2e/**/*.{ts,tsx,mts}',
];

/**
 * Base type-aware para um pacote TypeScript.
 * @param {{ tsconfigRootDir: string }} options diretório do pacote (use import.meta.dirname)
 */
export function createBaseConfig({ tsconfigRootDir }) {
  return defineConfig(
    generatedIgnores,
    { name: 'salon/js-recommended', ...js.configs.recommended },
    tseslint.configs.strictTypeChecked,
    {
      name: 'salon/typescript',
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      linterOptions: { reportUnusedDisableDirectives: 'error' },
      rules: {
        '@typescript-eslint/switch-exhaustiveness-check': [
          'error',
          { considerDefaultExhaustiveForUnions: true },
        ],
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        '@typescript-eslint/no-confusing-void-expression': [
          'error',
          { ignoreArrowShorthand: true },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
            ignoreRestSiblings: true,
          },
        ],
        '@typescript-eslint/consistent-type-assertions': [
          'error',
          { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
        ],
        '@typescript-eslint/no-import-type-side-effects': 'error',
      },
    },
    { name: 'salon/security', ...security.configs.recommended },
    {
      name: 'salon/security-ajustes',
      rules: {
        // Ruído alto em TypeScript (todo acesso obj[k]); noUncheckedIndexedAccess cobre o risco real.
        'security/detect-object-injection': 'off',
      },
    },
    {
      name: 'salon/testes',
      files: testFiles,
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        // expect(obj.metodo) e vi.fn() geram falso positivo.
        '@typescript-eslint/unbound-method': 'off',
      },
    },
    {
      name: 'salon/javascript',
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
      languageOptions: { globals: globals.node },
    },
  );
}

const CLOCK_MESSAGE = 'Domínio puro: leia o tempo pelo Clock injetado.';

/**
 * Seletores proibidos no domínio puro. Exportado para composição: no ESLint, uma
 * segunda declaração de no-restricted-syntax SUBSTITUI a anterior em vez de somar.
 */
export const pureDomainRestrictedSyntax = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: CLOCK_MESSAGE,
  },
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: CLOCK_MESSAGE },
  {
    selector: "CallExpression[callee.name='Date']",
    message: `${CLOCK_MESSAGE} Date() sem new devolve o horário atual.`,
  },
  {
    selector: "MemberExpression[object.name='Temporal'][property.name='Now']",
    message: CLOCK_MESSAGE,
  },
  {
    selector: "MemberExpression[object.name='performance'][property.name='now']",
    message: CLOCK_MESSAGE,
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'Domínio puro: injete a fonte de aleatoriedade.',
  },
  {
    selector:
      // biome-ignore lint/security/noSecrets: seletor AST do ESLint, não é segredo.
      "MemberExpression[object.name='crypto'][property.name=/^(randomUUID|getRandomValues)$/]",
    message: 'Domínio puro: IDs e bytes aleatórios vêm de um gerador injetado.',
  },
  {
    selector:
      // biome-ignore lint/security/noSecrets: seletor AST do ESLint, não é segredo.
      'CallExpression[callee.property.name=/^(get|set)(FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)$/]',
    message:
      'Métodos locais de Date dependem do fuso da máquina: use Temporal com o fuso IANA da unidade.',
  },
  {
    // biome-ignore lint/security/noSecrets: seletor AST do ESLint, não é segredo.
    selector: "CallExpression[callee.property.name='resolvedOptions']",
    message: 'Não dependa do fuso/locale da máquina: o fuso IANA da unidade é um dado de entrada.',
  },
];

const IO_MESSAGE = 'Domínio puro: sem I/O. Receba os dados por parâmetro (portas e adaptadores).';

const nodeBuiltins = builtinModules.filter((name) => !name.startsWith('_'));

/**
 * Regras de pureza do domínio (sem relógio, aleatoriedade, I/O nem framework).
 * @param {{ files: string[], ignores?: string[] }} options arquivos do domínio
 */
export function createPureDomainConfig({ files, ignores = [] }) {
  return defineConfig({
    name: 'salon/dominio-puro',
    files,
    ignores,
    rules: {
      'no-restricted-syntax': ['error', ...pureDomainRestrictedSyntax],
      'no-restricted-globals': [
        'error',
        ...[
          'process',
          'Buffer',
          'fetch',
          'XMLHttpRequest',
          'WebSocket',
          'setTimeout',
          'setInterval',
          'setImmediate',
          'window',
          'document',
          'localStorage',
          'sessionStorage',
        ].map((name) => ({ name, message: IO_MESSAGE })),
      ],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            ...nodeBuiltins.map((name) => ({ name, message: IO_MESSAGE })),
            ...[
              'pg',
              'drizzle-orm',
              'uuid',
              'next',
              'react',
              'react-dom',
              '@salon/db',
              '@salon/web',
            ].map((name) => ({ name, message: IO_MESSAGE })),
            {
              name: 'temporal-polyfill/global',
              message: 'Não altere globais: importe { Temporal } de "temporal-polyfill".',
            },
            { name: 'temporal-polyfill/fns/Now', message: CLOCK_MESSAGE },
          ],
          patterns: [
            {
              group: ['node:*', 'pg/*', 'drizzle-orm/*', 'next/*', 'react-dom/*', '@salon/db/*'],
              message: IO_MESSAGE,
            },
          ],
        },
      ],
    },
  });
}
