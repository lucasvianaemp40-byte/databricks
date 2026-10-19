// @ts-check
import { defineConfig } from 'eslint/config';
import {
  createBaseConfig,
  createPureDomainConfig,
  machineTimeZoneRestrictedProperties,
  pureDomainRestrictedSyntax,
} from '../../eslint.base.mjs';

const CLOCK_MESSAGE = 'Domínio puro: leia o tempo pelo Clock injetado.';
const TEMPORAL_ONLY_MESSAGE =
  'O domínio usa Temporal: Date depende do fuso da máquina e não carrega fuso IANA.';
const MACHINE_LOCALE_MESSAGE =
  'Formatação local depende do fuso/idioma da máquina: monte o rótulo no fuso da unidade.';

/**
 * Regras próprias do @salon/scheduling-core, somadas às da base (eslint.base.mjs).
 * Valem também para os testes em src/: teste determinístico não lê relógio nem sorteia.
 * test/lint-rules.test.ts prova que cada regra dispara.
 *
 * A dica de exclusão de cobertura (no-warning-comments) vem só da base, bloco
 * salon/cobertura-honesta, que vale para todo arquivo: test/lint-rules.test.ts prova que ela
 * dispara em src/ e em test/ deste pacote.
 */
export const schedulingCoreDomainRules = defineConfig({
  name: 'scheduling-core/tempo-e-aleatoriedade',
  files: ['src/**/*.ts'],
  rules: {
    // Pega também a referência sem chamada (const agora = Date.now), invisível ao
    // no-restricted-syntax, que só olha chamadas. Redeclarar no-restricted-properties
    // SUBSTITUI as opções da base: por isso a composição com
    // machineTimeZoneRestrictedProperties (Date.parse por chamada, referência, colchetes ou
    // desestruturação).
    'no-restricted-properties': [
      'error',
      ...machineTimeZoneRestrictedProperties,
      { object: 'Date', property: 'now', message: CLOCK_MESSAGE },
      { object: 'Temporal', property: 'Now', message: CLOCK_MESSAGE },
      { object: 'performance', property: 'now', message: CLOCK_MESSAGE },
      {
        object: 'Math',
        property: 'random',
        message: 'Domínio puro: injete a fonte de aleatoriedade.',
      },
      {
        object: 'globalThis',
        property: 'Temporal',
        message: 'Importe { Temporal } de "temporal-polyfill" (troca única ao migrar p/ Node 26).',
      },
    ],
    // Redeclarar no-restricted-syntax também SUBSTITUI as opções anteriores: por isso a
    // composição com pureDomainRestrictedSyntax (Date.now, new Date(), Temporal.Now,
    // Math.random...). O seletor de new Date(x) abaixo já cobre todo
    // machineTimeZoneRestrictedSyntax.
    'no-restricted-syntax': [
      'error',
      ...pureDomainRestrictedSyntax,
      {
        selector: "NewExpression[callee.name='Date'][arguments.length>0]",
        message: TEMPORAL_ONLY_MESSAGE,
      },
      {
        // Date.parse('2026-11-03T09:00') usa o fuso da máquina; Date.UTC é aritmética manual.
        selector: "CallExpression[callee.object.name='Date'][callee.property.name!='now']",
        message: TEMPORAL_ONLY_MESSAGE,
      },
      {
        // biome-ignore lint/security/noSecrets: seletor AST do ESLint, não é segredo.
        selector: 'CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/]',
        message: MACHINE_LOCALE_MESSAGE,
      },
    ],
  },
});

export default defineConfig(
  createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  // Domínio puro: sem relógio, aleatoriedade, I/O nem framework (o Clock entra por injeção).
  createPureDomainConfig({ files: ['src/**/*.ts'] }),
  schedulingCoreDomainRules,
);
