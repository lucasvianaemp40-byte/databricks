import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';

/**
 * Conta do dono, login e criação do salão (threat model 2026-10-30-conta-e-salao), contra o
 * build de produção com PostgreSQL real (scripts/with-e2e-database.mjs).
 */

// Frase longa e de baixa entropia: só para teste, nunca uma credencial real.
const PASSWORD = 'uma frase bem comprida de teste';

function uniqueOwner(label: string) {
  // Só letras: um id com 8 dígitos seguidos seria recusado no endereço (sem telefone/CPF).
  const id = Array.from(randomBytes(8), (byte) => String.fromCharCode(97 + (byte % 26))).join('');
  return {
    name: `Dona ${label}`,
    email: `dona.${label}.${id}@exemplo.test`,
    slug: `salao-${label}-${id}`,
  };
}

async function signUp(page: Page, owner: { name: string; email: string }) {
  await page.goto('/cadastro');
  await page.getByLabel('Seu nome').fill(owner.name);
  await page.getByLabel('E-mail').fill(owner.email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/salao\/novo$/);
}

async function createSalon(page: Page, salon: { name: string; slug: string; location: string }) {
  await page.getByLabel('Nome do salão').fill(salon.name);
  await page.getByLabel('Endereço da página de agendamento').fill(salon.slug);
  await page.getByLabel('Nome da primeira unidade').fill(salon.location);
  await page.getByLabel('Fuso horário da unidade').selectOption('America/Manaus');
  await page.getByRole('button', { name: 'Criar salão' }).click();
  await expect(page).toHaveURL(/\/painel$/);
}

test.describe('conta do dono e criação do salão', () => {
  test('cria a conta, cria o salão e cai no painel; sai e entra de novo', async ({ page }) => {
    const owner = uniqueOwner('fluxo');
    await signUp(page, owner);
    await createSalon(page, { name: 'Barbearia Fluxo', slug: owner.slug, location: 'Centro' });

    await expect(page.getByRole('heading', { level: 1, name: 'Barbearia Fluxo' })).toBeVisible();
    await expect(page.getByText(`Olá, ${owner.name} (Dono).`)).toBeVisible();
    await expect(page.getByText('Fuso: Amazonas (Manaus)')).toBeVisible();
    await expect(page.getByText(owner.slug)).toBeVisible();

    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/entrar$/);
    await page.goto('/painel');
    await expect(page).toHaveURL(/\/entrar$/);

    await page.getByLabel('E-mail').fill(owner.email);
    await page.getByLabel('Senha').fill(PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page).toHaveURL(/\/painel$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Barbearia Fluxo' })).toBeVisible();
  });

  test('todo Set-Cookie usa __Host-, Secure, HttpOnly, SameSite=Lax, Path=/ e nenhum Domain', async ({
    page,
  }) => {
    const setCookies: string[] = [];
    page.on('response', async (response) => {
      for (const header of await response.headersArray()) {
        if (header.name.toLowerCase() === 'set-cookie') {
          setCookies.push(header.value);
        }
      }
    });
    const owner = uniqueOwner('cookie');
    await signUp(page, owner);
    await createSalon(page, { name: 'Salão Cookie', slug: owner.slug, location: 'Centro' });
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/entrar$/);

    expect(setCookies.length).toBeGreaterThan(0);
    for (const cookie of setCookies) {
      const [nameValue = '', ...attributes] = cookie.split(';').map((part) => part.trim());
      const lower = attributes.map((attribute) => attribute.toLowerCase());
      expect(nameValue, cookie).toMatch(/^__Host-/);
      expect(lower, cookie).toContain('secure');
      expect(lower, cookie).toContain('httponly');
      expect(lower, cookie).toContain('path=/');
      expect(lower, cookie).toContain('samesite=lax');
      expect(
        lower.some((attribute) => attribute.startsWith('domain=')),
        cookie,
      ).toBe(false);
    }
  });

  test('sem sessão, painel e criação do salão levam ao login', async ({ page }) => {
    for (const path of ['/painel', '/salao/novo'] as const) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/entrar$/);
    }
  });

  test('login errado: a mesma mensagem para e-mail inexistente e para senha errada', async ({
    page,
  }) => {
    const owner = uniqueOwner('login');
    await signUp(page, owner);
    await page.context().clearCookies();

    const attempts = [
      { email: owner.email, password: 'senha errada mas comprida' },
      { email: `ninguem.${owner.slug}@exemplo.test`, password: PASSWORD },
    ];
    const messages: string[] = [];
    for (const attempt of attempts) {
      await page.goto('/entrar');
      await page.getByLabel('E-mail').fill(attempt.email);
      await page.getByLabel('Senha').fill(attempt.password);
      await page.getByRole('button', { name: 'Entrar' }).click();
      // O Next também tem um role=alert (anunciador de rota): a mensagem é a do formulário.
      const alert = page.locator('form').getByRole('alert');
      await expect(alert).toHaveText('E-mail ou senha incorretos.');
      messages.push((await alert.textContent()) ?? '');
    }
    expect(messages[0]).toBe(messages[1]);
  });

  test('muitas senhas erradas no mesmo e-mail: o login passa a pedir para esperar', async ({
    browser,
  }) => {
    // IP próprio por cabeçalho: sem proxy na frente, o app usa o x-forwarded-for, e o teste
    // não gasta a cota de 127.0.0.1 dos outros testes. O limite por e-mail não depende disso.
    const ip = `198.51.100.${String(1 + ((randomBytes(1)[0] ?? 0) % 250))}`;
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
    try {
      const page = await context.newPage();
      const owner = uniqueOwner('limite');
      await signUp(page, owner);
      await context.clearCookies();
      const alert = page.locator('form').getByRole('alert');
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        await page.goto('/entrar');
        await page.getByLabel('E-mail').fill(owner.email);
        await page.getByLabel('Senha').fill('senha errada mas comprida');
        await page.getByRole('button', { name: 'Entrar' }).click();
        await expect(alert).toHaveText('E-mail ou senha incorretos.');
      }
      // A 11ª, mesmo com a senha CERTA, espera: força bruta não confirma o acerto.
      await page.goto('/entrar');
      await page.getByLabel('E-mail').fill(owner.email);
      await page.getByLabel('Senha').fill(PASSWORD);
      await page.getByRole('button', { name: 'Entrar' }).click();
      await expect(alert).toHaveText(/Muitas tentativas seguidas/);
      await expect(page).toHaveURL(/\/entrar$/);
    } finally {
      await context.close();
    }
  });

  test('cadastro recusa senha curta no servidor, sem perder nome e e-mail', async ({ page }) => {
    const owner = uniqueOwner('senha');
    await page.goto('/cadastro');
    await page.getByLabel('Seu nome').fill(owner.name);
    await page.getByLabel('E-mail').fill(owner.email);
    await page.getByLabel('Senha').fill('curta');
    await page.getByRole('button', { name: 'Criar conta' }).click();
    await expect(page.getByText('A senha precisa ter pelo menos 12 caracteres.')).toBeVisible();
    await expect(page.getByLabel('E-mail')).toHaveValue(owner.email);
    await expect(page.getByLabel('Senha')).toHaveValue('');
    await expect(page).toHaveURL(/\/cadastro$/);
  });

  test('dois donos, dois salões: cada um só vê o próprio painel', async ({ browser }) => {
    const ownerA = uniqueOwner('a');
    const ownerB = uniqueOwner('b');
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      await signUp(pageA, ownerA);
      await createSalon(pageA, { name: 'Salão da Ana', slug: ownerA.slug, location: 'Centro' });
      await signUp(pageB, ownerB);
      await createSalon(pageB, { name: 'Salão da Bia', slug: ownerB.slug, location: 'Bairro' });

      await pageB.goto('/painel');
      await expect(pageB.getByRole('heading', { level: 1, name: 'Salão da Bia' })).toBeVisible();
      await expect(pageB.getByText('Salão da Ana')).toHaveCount(0);
      await expect(pageB.getByText(ownerA.slug)).toHaveCount(0);

      await pageA.goto('/painel');
      await expect(pageA.getByRole('heading', { level: 1, name: 'Salão da Ana' })).toBeVisible();
      await expect(pageA.getByText('Salão da Bia')).toHaveCount(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('endereço já usado por outro salão é recusado com mensagem no campo', async ({
    browser,
  }) => {
    const first = uniqueOwner('dono1');
    const second = uniqueOwner('dono2');
    const contextFirst = await browser.newContext();
    const contextSecond = await browser.newContext();
    try {
      const pageFirst = await contextFirst.newPage();
      await signUp(pageFirst, first);
      await createSalon(pageFirst, {
        name: 'Primeiro Salão',
        slug: first.slug,
        location: 'Centro',
      });

      const pageSecond = await contextSecond.newPage();
      await signUp(pageSecond, second);
      await pageSecond.getByLabel('Nome do salão').fill('Segundo Salão');
      await pageSecond.getByLabel('Endereço da página de agendamento').fill(first.slug);
      await pageSecond.getByLabel('Nome da primeira unidade').fill('Centro');
      await pageSecond.getByRole('button', { name: 'Criar salão' }).click();
      await expect(
        pageSecond.getByText('Este endereço já está em uso por outro salão. Escolha outro.'),
      ).toBeVisible();
      await expect(pageSecond).toHaveURL(/\/salao\/novo$/);
    } finally {
      await contextFirst.close();
      await contextSecond.close();
    }
  });

  test('criação do salão e painel não têm violações de acessibilidade', async ({
    page,
    makeAxeBuilder,
  }) => {
    const owner = uniqueOwner('a11y');
    await signUp(page, owner);
    expect((await makeAxeBuilder().analyze()).violations).toEqual([]);
    await createSalon(page, { name: 'Salão Acessível', slug: owner.slug, location: 'Centro' });
    expect((await makeAxeBuilder().analyze()).violations).toEqual([]);
  });
});
