import AxeBuilder from '@axe-core/playwright';
import { test as base, expect } from '@playwright/test';
import { consoleProblem } from './console';

/** WCAG 2.2 AA completo: o axe marca cada regra só com a versão em que ela entrou. */
const WCAG_22_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Fixtures {
  /**
   * Mensagens de console esperadas no teste, casadas com "texto (URL de origem)". Seja
   * específico: para o 404 do próprio documento use MISSING_PAGE_DOCUMENT_404, que não
   * esconde 404 de CSS ou JS da mesma página.
   */
  allowedConsoleErrors: RegExp[];
  /**
   * Falha o teste se a página registrar erro no console, aviso de Permissions-Policy ou
   * exceção não tratada. Pega violações de CSP ("Refused to execute…"), falhas de hidratação,
   * recursos 404 e Permissions-Policy malformada (erro) ou com recurso desconhecido (o
   * Chromium só emite warning). Regras em ./console.ts, testadas em e2e/console-guard.spec.ts.
   * Automática: vale para todo teste com `page`.
   */
  failOnConsoleErrors: undefined;
  /** Axe com as tags WCAG 2.2 AA. Não use exclude(): ele desliga todas as regras do trecho. */
  makeAxeBuilder: () => AxeBuilder;
}

export const test = base.extend<Fixtures>({
  allowedConsoleErrors: [[], { option: true }],

  failOnConsoleErrors: [
    async ({ page, allowedConsoleErrors }, use) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        const problem = consoleProblem(message, allowedConsoleErrors);
        if (problem !== undefined) {
          errors.push(problem);
        }
      });
      page.on('pageerror', (error) => {
        errors.push(`pageerror: ${error.message}`);
      });
      await use(undefined);
      expect(errors, 'erros no console do navegador').toEqual([]);
    },
    { auto: true },
  ],

  makeAxeBuilder: async ({ page }, use) => {
    await use(() => new AxeBuilder({ page }).withTags(WCAG_22_AA_TAGS));
  },
});

export { expect };
