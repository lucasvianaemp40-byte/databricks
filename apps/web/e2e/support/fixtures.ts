import AxeBuilder from '@axe-core/playwright';
import { test as base, expect } from '@playwright/test';

/** WCAG 2.2 AA completo: o axe marca cada regra só com a versão em que ela entrou. */
const WCAG_22_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Fixtures {
  /** Mensagens de console esperadas no teste (ex.: o 404 do próprio documento). */
  allowedConsoleErrors: RegExp[];
  /**
   * Falha o teste se a página registrar erro no console ou exceção não tratada. Pega
   * violações de CSP ("Refused to execute…"), falhas de hidratação, Permissions-Policy com
   * recurso desconhecido e recursos 404. Automática: vale para todo teste com `page`.
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
        if (message.type() !== 'error') {
          return;
        }
        const text = `${message.text()} (${message.location().url})`;
        if (!allowedConsoleErrors.some((pattern) => pattern.test(text))) {
          errors.push(text);
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
