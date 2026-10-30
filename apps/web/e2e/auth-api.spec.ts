import { createVerifiedAccount, messagesTo, PASSWORD, uniqueEmail, uniqueIp } from './support/auth';
import { expect, test } from './support/fixtures';

/** Chaves (recursivas) de um JSON, para comparar o formato de duas respostas. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(shape);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, shape(inner)]),
    );
  }
  return typeof value;
}

test.describe('API de autenticação (/api/auth)', () => {
  test('cadastro responde igual para e-mail novo e já cadastrado (sem enumeração)', async ({
    request,
  }) => {
    const email = uniqueEmail();
    const headers = { 'x-real-ip': uniqueIp() };
    const body = { name: 'Ana', email, password: PASSWORD };
    const first = await request.post('/api/auth/sign-up/email', { data: body, headers });
    const second = await request.post('/api/auth/sign-up/email', { data: body, headers });
    expect(first.status()).toBe(200);
    expect(second.status()).toBe(first.status());
    expect(shape(await second.json())).toEqual(shape(await first.json()));
    // Só a conta nova recebe o link.
    expect(await messagesTo(email)).toHaveLength(1);

    // Entrada inválida: o mesmo 400 genérico exista ou não a conta.
    for (const target of [email, uniqueEmail('nova')]) {
      const invalid = await request.post('/api/auth/sign-up/email', {
        data: { name: 'Ana\nBcc: x@y', email: target, password: PASSWORD },
        headers,
      });
      expect(invalid.status()).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  test('rotas fora da lista fechada respondem 404', async ({ request }) => {
    for (const [method, path] of [
      ['GET', '/api/auth/get-session'],
      ['POST', '/api/auth/update-user'],
      ['POST', '/api/auth/change-email'],
      ['POST', '/api/auth/delete-user'],
      ['POST', '/api/auth/send-verification-email'],
      ['POST', '/api/auth/request-password-reset'],
      ['POST', '/api/auth/organization/create'],
      ['GET', '/api/auth/list-sessions'],
      ['GET', '/api/auth/ok'],
    ] as const) {
      const response = await request.fetch(path, {
        method,
        data: method === 'POST' ? {} : undefined,
      });
      expect(response.status(), `${method} ${path}`).toBe(404);
    }
  });

  test('POST de outra origem é recusado (CSRF e login CSRF)', async ({ request }) => {
    for (const [path, data] of [
      ['/api/auth/sign-in/email', { email: uniqueEmail(), password: PASSWORD }],
      ['/api/auth/sign-up/email', { name: 'Ana', email: uniqueEmail(), password: PASSWORD }],
    ] as const) {
      const response = await request.post(path, {
        data,
        headers: {
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'cors',
          'x-real-ip': uniqueIp(),
        },
      });
      expect(response.status(), path).toBe(403);
    }
  });

  test('callbackURL externo é recusado (open redirect)', async ({ request }) => {
    for (const callbackURL of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const email = uniqueEmail();
      const response = await request.post('/api/auth/sign-up/email', {
        data: { name: 'Ana', email, password: PASSWORD, callbackURL },
        headers: { 'x-real-ip': uniqueIp() },
      });
      // Recusado por quem pegar primeiro: a checagem de origem do Better Auth (403, URLs
      // absolutas e de protocolo relativo) ou o nosso hook (400). Nada é criado nem enviado.
      expect([400, 403], `${callbackURL}: ${response.status()}`).toContain(response.status());
      expect(await messagesTo(email), callbackURL).toEqual([]);
    }
    const verify = await request.get(
      // biome-ignore lint/security/noSecrets: URL de teste, não é segredo.
      '/api/auth/verify-email?token=x&callbackURL=https%3A%2F%2Fevil.example',
      { maxRedirects: 0 },
    );
    expect(verify.status()).toBe(400);
  });

  test('Host forjado não muda o link do e-mail de confirmação', async ({ request, baseURL }) => {
    const email = uniqueEmail();
    const response = await request.post('/api/auth/sign-up/email', {
      data: { name: 'Ana', email, password: PASSWORD },
      headers: { 'x-forwarded-host': 'evil.example', 'x-real-ip': uniqueIp() },
    });
    expect(response.status()).toBe(200);
    const [message] = await messagesTo(email);
    expect(message?.text).toContain(`${baseURL ?? ''}/api/auth/verify-email?token=`);
    expect(message?.text).not.toContain('evil.example');
    // biome-ignore lint/security/noSecrets: caminho de teste, não é segredo.
    expect(message?.text).toContain('callbackURL=%2Fcadastro%2Fconfirmado');
  });

  test('login: a 6ª tentativa do mesmo IP no minuto recebe 429; outro IP segue livre', async ({
    request,
  }) => {
    const ip = uniqueIp();
    const attempt = (from: string) =>
      request.post('/api/auth/sign-in/email', {
        data: { email: uniqueEmail(), password: 'senha errada mas longa' },
        headers: { 'x-real-ip': from },
      });
    for (let index = 0; index < 5; index += 1) {
      expect((await attempt(ip)).status()).toBe(401);
    }
    const blocked = await attempt(ip);
    expect(blocked.status()).toBe(429);
    expect((await attempt(uniqueIp())).status()).toBe(401);
  });

  test('User-Agent gigante não derruba o login (é truncado antes de gravar a sessão)', async ({
    request,
  }) => {
    const ip = uniqueIp();
    const { email } = await createVerifiedAccount(request, { ip });
    const response = await request.post('/api/auth/sign-in/email', {
      data: { email, password: PASSWORD },
      headers: { 'x-real-ip': ip, 'user-agent': `Navegador/${'a'.repeat(3000)}` },
    });
    expect(response.status()).toBe(200);
  });

  test('respostas de autenticação não ficam em cache nem vazam o link em Referer', async ({
    request,
  }) => {
    const response = await request.post('/api/auth/sign-in/email', {
      data: { email: uniqueEmail(), password: 'senha errada mas longa' },
      headers: { 'x-real-ip': uniqueIp() },
    });
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
  });
});
