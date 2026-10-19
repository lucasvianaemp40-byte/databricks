/**
 * Atalho para o portão pelo resultado, que é compartilhado pelos pacotes Vitest e mora na raiz
 * (test-support/vitest-no-disabled-tests-reporter.ts). Existe porque
 * test/no-disabled-tests-reporter.test.ts sobe o Vitest com `--reporter=<este arquivo>`;
 * test/test-hygiene.test.ts prova que ele reexporta a mesma classe que vitest.config.ts usa.
 * Quando o meta-teste apontar direto para o módulo da raiz, apague este arquivo.
 */
export { default } from '../../../../test-support/vitest-no-disabled-tests-reporter';
