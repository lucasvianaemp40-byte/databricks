import { describe, expect, it } from 'vitest';
import { createAuthRouteHandler } from './route-handler';

function handler(appEnv = 'e2e') {
  const calls: string[] = [];
  const handle = createAuthRouteHandler({
    appEnv,
    handle: (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return Promise.resolve(Response.redirect('http://127.0.0.1:3100/cadastro/confirmado', 302));
    },
  });
  return { handle, calls };
}

const request = (method: string, path: string, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:3100${path}`, { method, headers });

describe('handler de /api/auth', () => {
  it('rota fora da lista fechada: 404 sem chegar ao Better Auth', async () => {
    const { handle, calls } = handler();
    for (const [method, path] of [
      ['POST', '/api/auth/update-user'],
      ['POST', '/api/auth/organization/create'],
      ['GET', '/api/auth/get-session'],
      ['GET', '/api/auth/sign-out'],
    ] as const) {
      const response = await handle(request(method, path));
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it('rota liberada: repassa e marca no-store e no-referrer (mesmo num redirect imutável)', async () => {
    const { handle, calls } = handler();
    const response = await handle(request('GET', '/api/auth/verify-email?token=x'));
    expect(calls).toEqual(['GET /api/auth/verify-email']);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://127.0.0.1:3100/cadastro/confirmado');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('clear-site-data')).toBeNull();
  });

  it('logout bem-sucedido limpa cache e armazenamento do navegador', async () => {
    const handle = createAuthRouteHandler({
      appEnv: 'e2e',
      handle: () => Promise.resolve(Response.json({ success: true })),
    });
    const response = await handle(request('POST', '/api/auth/sign-out'));
    expect(response.headers.get('clear-site-data')).toBe('"cache", "storage"');
  });

  it('falha inesperada da biblioteca: 500 genérico e log sem a mensagem nem os parâmetros', async () => {
    const logs: string[] = [];
    const leaked = Object.assign(
      new Error('Failed query: insert into "auth"."users" params: ana@example.test,Ana Souza'),
      {
        name: 'DrizzleQueryError',
        cause: { code: '23502', detail: 'Failing row contains (ana@example.test)' },
      },
    );
    const handle = createAuthRouteHandler({
      appEnv: 'e2e',
      handle: () => Promise.reject(leaked),
      logFailure: (line) => logs.push(line),
    });
    const response = await handle(request('POST', '/api/auth/sign-up/email'));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('ana@example.test');
    expect(logs).toEqual([
      '[auth] falha em POST /sign-up/email: DrizzleQueryError (SQLSTATE 23502)',
    ]);
    expect(logs.join()).not.toContain('example.test');
  });

  it.each(['production', 'preview'])(
    'em %s, sem x-real-ip válido a requisição é recusada (rate limit não fica sem IP)',
    async (appEnv) => {
      const { handle, calls } = handler(appEnv);
      expect((await handle(request('POST', '/api/auth/sign-in/email'))).status).toBe(400);
      expect(
        (
          await handle(
            request('POST', '/api/auth/sign-in/email', { 'x-real-ip': '1.1.1.1, 2.2.2.2' }),
          )
        ).status,
      ).toBe(400);
      expect(calls).toEqual([]);
      await handle(request('POST', '/api/auth/sign-in/email', { 'x-real-ip': '203.0.113.9' }));
      expect(calls).toEqual(['POST /api/auth/sign-in/email']);
    },
  );
});
