import { expect, test } from './support/fixtures';

test.describe('página inicial', () => {
  test('renderiza em pt-BR com título, landmarks e um único h1', async ({ page }) => {
    const response = await page.goto('/');

    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('Agenda Salão: agendamento online para salões');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(
      page.getByRole('heading', { level: 1, name: 'A agenda do seu salão, aberta 24 horas' }),
    ).toBeVisible();
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();
  });

  test('mostra as etapas com os rótulos dos status do domínio', async ({ page }) => {
    await page.goto('/');

    const journey = page.getByRole('region', { name: 'Cada atendimento, do pedido ao fim' });
    await expect(journey.getByRole('listitem')).toHaveText([
      /Aguardando confirmação/,
      /Confirmado/,
      /Em atendimento/,
      /Concluído/,
    ]);
  });

  test('não é indexável fora da produção', async ({ page }) => {
    await page.goto('/');

    // biome-ignore lint/security/noSecrets: seletor CSS, não é segredo.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );
  });

  test('o link "Pular para o conteúdo" é o primeiro foco e leva ao conteúdo', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'Navegação por Tab é de teclado físico (desktop).');
    await page.goto('/');

    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Pular para o conteúdo' });
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#conteudo$/);
    await expect(page.getByRole('main')).toBeFocused();
  });
});

test.describe('página não encontrada', () => {
  test.use({ allowedConsoleErrors: [/status of 404/] });

  test('responde 404 em pt-BR e volta para o início por navegação no cliente', async ({ page }) => {
    const response = await page.goto('/pagina-que-nao-existe');

    expect(response?.status()).toBe(404);
    await expect(page).toHaveTitle('Página não encontrada | Agenda Salão');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Página não encontrada' }),
    ).toBeVisible();

    // A navegação pelo <Link> só acontece no cliente se o JS do Next carregou sob a CSP.
    await page.getByRole('link', { name: 'Voltar para a página inicial' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'A agenda do seu salão, aberta 24 horas',
    );
  });
});
