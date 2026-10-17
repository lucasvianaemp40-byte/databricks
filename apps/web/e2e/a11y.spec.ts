import type AxeBuilder from '@axe-core/playwright';
import { expect, test } from './support/fixtures';

type AxeViolation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number];

/** Resumo legível das violações para a mensagem de falha. */
function summarize(violations: readonly AxeViolation[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'sem impacto'}): ${violation.help} -> ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

const PAGES = [
  { name: 'página inicial', path: '/', status: 200 },
  { name: 'página não encontrada', path: '/pagina-que-nao-existe', status: 404 },
] as const;

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`acessibilidade WCAG 2.2 AA (tema ${colorScheme === 'light' ? 'claro' : 'escuro'})`, () => {
    test.use({ colorScheme, allowedConsoleErrors: [/status of 404/] });

    for (const { name, path, status } of PAGES) {
      test(`${name} não tem violações automáticas`, async ({ page, makeAxeBuilder }) => {
        const response = await page.goto(path);
        expect(response?.status()).toBe(status);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

        const results = await makeAxeBuilder().analyze();

        expect(summarize(results.violations)).toEqual([]);
      });
    }
  });
}
