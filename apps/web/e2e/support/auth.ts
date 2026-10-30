/* eslint-disable security/detect-non-literal-fs-filename -- lê só a pasta MAIL_OUTBOX_DIR criada pelo scripts/with-e2e-database.ts. */
import { randomInt, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { expect } from './fixtures';

/**
 * Apoio dos E2E de autenticação. Precisam do build local com banco e outbox (o `pnpm e2e`
 * prepara os dois por scripts/with-e2e-database.ts); sem eles, a config tira estes specs.
 */

export const PASSWORD = 'uma frase longa e secreta';

/** E-mail único do domínio reservado `.test` (nunca um endereço real). */
export function uniqueEmail(prefix = 'dona'): string {
  return `${prefix}.${randomUUID().slice(0, 12)}@example.test`;
}

/**
 * IP de cliente único por teste (`x-real-ip`, o cabeçalho que a borda escreveria): o rate
 * limit conta por IP, então testes paralelos não dividem o mesmo balde.
 */
export function uniqueIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

export async function assignUniqueIp(context: BrowserContext): Promise<string> {
  const ip = uniqueIp();
  await context.setExtraHTTPHeaders({ 'x-real-ip': ip });
  return ip;
}

function outboxDir(): string {
  const dir = process.env.MAIL_OUTBOX_DIR;
  if (dir === undefined || dir === '') {
    throw new Error('MAIL_OUTBOX_DIR ausente: rode pelo `pnpm e2e` (prepara banco e outbox).');
  }
  return dir;
}

interface OutboxMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Mensagens já gravadas para um destinatário, da mais antiga para a mais nova. */
export async function messagesTo(email: string): Promise<OutboxMessage[]> {
  const dir = outboxDir();
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  const messages = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8')) as OutboxMessage),
  );
  return messages.filter((message) => message.to === email);
}

/** Link de confirmação mais recente enviado ao e-mail (espera chegar ao outbox). */
export async function verificationLink(email: string): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(async () => {
      const last = (await messagesTo(email)).at(-1);
      link = last === undefined ? undefined : /https?:\/\/\S+/.exec(last.text)?.[0];
      return link;
    })
    .toBeDefined();
  return link ?? '';
}

/** Conta confirmada criada pela API (mais rápido que pela tela, para os testes de painel). */
export async function createVerifiedAccount(
  request: APIRequestContext,
  options: { readonly name?: string; readonly email?: string; readonly ip?: string } = {},
): Promise<{ readonly email: string; readonly name: string }> {
  const email = options.email ?? uniqueEmail();
  const name = options.name ?? 'Dona do Salão';
  const headers = { 'x-real-ip': options.ip ?? uniqueIp() };
  const response = await request.post('/api/auth/sign-up/email', {
    data: { name, email, password: PASSWORD },
    headers,
  });
  expect(response.status()).toBe(200);
  const confirmation = await request.get(await verificationLink(email), { headers });
  expect(confirmation.url()).toMatch(/\/cadastro\/confirmado$/);
  return { email, name };
}

export async function signInThroughUi(page: Page, email: string): Promise<void> {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

export async function createSalonThroughUi(
  page: Page,
  salon: { readonly name: string; readonly location?: string; readonly timezone?: string },
): Promise<void> {
  await expect(page).toHaveURL(/\/app\/criar-salao$/);
  await page.getByLabel('Nome do salão').fill(salon.name);
  // Endereço único por teste (o slug é global). Letras entre os grupos: o app recusa 8+
  // dígitos seguidos (CPF, telefone), e um trecho de UUID pode sair só com dígitos.
  const id = randomUUID();
  await page
    .getByLabel('Endereço da página de agendamento')
    .fill(`salao-${id.slice(0, 4)}x${id.slice(4, 8)}y${id.slice(9, 13)}`);
  await page.getByLabel('Nome da unidade').fill(salon.location ?? 'Unidade Centro');
  await page
    .getByLabel('Fuso horário da unidade')
    .selectOption(salon.timezone ?? 'America/Sao_Paulo');
  await page.getByRole('button', { name: 'Criar salão' }).click();
  await expect(page).toHaveURL(/\/app$/);
}
