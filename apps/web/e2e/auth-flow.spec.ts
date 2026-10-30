import {
  assignUniqueIp,
  createSalonThroughUi,
  createVerifiedAccount,
  PASSWORD,
  signInThroughUi,
  uniqueEmail,
  verificationLink,
} from './support/auth';
import { expect, test } from './support/fixtures';

const SESSION_COOKIE = '__Host-salon.session_token';

test.describe('conta, salão e painel', () => {
  test.beforeEach(async ({ context }) => {
    await assignUniqueIp(context);
  });

  test('cadastro → confirmação → login → criar salão → painel → sair, com cookies __Host-', async ({
    page,
    context,
  }) => {
    const setCookies: string[] = [];
    const reading: Promise<void>[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/api/auth/')) {
        reading.push(
          response.headersArray().then((headers) => {
            for (const header of headers) {
              if (header.name.toLowerCase() === 'set-cookie') {
                setCookies.push(header.value);
              }
            }
          }),
        );
      }
    });
    const email = uniqueEmail();

    await page.goto('/');
    await page.getByRole('link', { name: 'Criar conta grátis' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Crie a conta do seu salão' }),
    ).toBeVisible();
    await page.getByLabel('Seu nome').fill('Ana Souza');
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Senha').fill(PASSWORD);
    await page.getByRole('button', { name: 'Criar conta' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Confirme seu e-mail' }),
    ).toBeVisible();

    // Sem login automático depois de confirmar (LC-06): a pessoa entra com a própria senha.
    await page.goto(await verificationLink(email));
    await expect(page).toHaveURL(/\/cadastro\/confirmado$/);
    await expect(page.getByRole('heading', { level: 1, name: 'E-mail confirmado' })).toBeVisible();
    expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain(SESSION_COOKIE);

    await signInThroughUi(page, email);
    await expect(page.getByRole('heading', { level: 1, name: 'Cadastre seu salão' })).toBeVisible();
    await createSalonThroughUi(page, {
      name: 'Salão Bela Vista',
      location: 'Unidade Manaus',
      timezone: 'America/Manaus',
    });
    await expect(
      page.getByRole('heading', { level: 1, name: 'Olá, Ana! Seu salão está pronto.' }),
    ).toBeVisible();
    const salon = page.getByRole('region', { name: 'Salão' });
    await expect(salon).toContainText('Salão Bela Vista');
    await expect(salon).toContainText('Teste grátis');
    const unit = page.getByRole('region', { name: 'Unidade' });
    await expect(unit).toContainText('Unidade Manaus');
    await expect(unit).toContainText('Amazonas (leste) (UTC−04:00)');

    // Todo Set-Cookie da autenticação: __Host-, Secure, HttpOnly, Path=/, SameSite=Lax, sem Domain.
    await Promise.all(reading);
    expect(setCookies.length).toBeGreaterThan(0);
    for (const cookie of setCookies) {
      expect(cookie).toMatch(/^__Host-salon\./);
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*Path=\/(;|$)/i);
      expect(cookie).toMatch(/;\s*SameSite=Lax/i);
      expect(cookie).not.toMatch(/;\s*Domain=/i);
    }
    const session = (await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE);
    expect(session).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' });

    // Página logada não fica em cache.
    const dashboard = await page.request.get('/app', { maxRedirects: 0 });
    expect(dashboard.headers()['cache-control']).toContain('no-store');

    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/entrar$/);
    await page.goto('/app');
    await expect(page).toHaveURL(/\/entrar$/);

    // O token antigo, recolocado no navegador, não vale mais: a sessão foi apagada no servidor.
    if (session === undefined) {
      throw new Error('cookie de sessão ausente');
    }
    await context.addCookies([session]);
    await page.goto('/app');
    await expect(page).toHaveURL(/\/entrar$/);
  });

  test.describe(() => {
    // O navegador registra o 401 da tentativa com senha errada.
    test.use({ allowedConsoleErrors: [/status of 401 \(Unauthorized\)/i] });

    test('senha errada e e-mail inexistente dão a mesma mensagem', async ({ page, request }) => {
      const { email } = await createVerifiedAccount(request);
      for (const candidate of [email, uniqueEmail('ninguem')]) {
        await page.goto('/entrar');
        await page.getByLabel('E-mail').fill(candidate);
        await page.getByLabel('Senha').fill('senha errada mas longa');
        await page.getByRole('button', { name: 'Entrar' }).click();
        // O anunciador de rota do Next também tem role="alert": o alerta é o do formulário.
        await expect(page.getByRole('form', { name: 'Entrar' }).getByRole('alert')).toHaveText(
          'E-mail ou senha incorretos.',
        );
      }
    });
  });

  test('o link de confirmação reaberto não cria sessão', async ({ page, browser }) => {
    const email = uniqueEmail();
    await page.request.post('/api/auth/sign-up/email', {
      data: { name: 'Ana', email, password: PASSWORD },
    });
    const link = await verificationLink(email);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fresh = await browser.newContext();
      const other = await fresh.newPage();
      await other.goto(link);
      await expect(other).toHaveURL(/\/cadastro\/confirmado$/);
      await other.goto('/app');
      await expect(other).toHaveURL(/\/entrar$/);
      await fresh.close();
    }
  });

  test('sem sessão, o painel e a criação do salão levam ao login', async ({ page }) => {
    for (const path of ['/app', '/app/criar-salao']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/entrar$/);
    }
  });

  test('nome com marcação aparece como texto (sem XSS)', async ({ page, request }) => {
    const { email } = await createVerifiedAccount(request);
    await signInThroughUi(page, email);
    await createSalonThroughUi(page, { name: '<img src=x onerror=alert(1)>' });
    await expect(page.getByRole('region', { name: 'Salão' })).toContainText(
      '<img src=x onerror=alert(1)>',
    );
    // biome-ignore lint/security/noSecrets: seletor CSS, não é segredo.
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  });
});
