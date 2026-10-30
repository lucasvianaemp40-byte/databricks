import { authAccounts, authRateLimits, authSessions, authUsers, createDb } from '@salon/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { createAuth, SESSION_MAX_AGE_SECONDS } = await import('./config');
const { ALLOWED_AUTH_ROUTES, VERIFICATION_CALLBACK_PATH } = await import('./http-policy');
const { createOutboxMailer, unavailableMailer } = await import('../mail/mailer');

const APP_URL = 'http://127.0.0.1:3100';
// Pool sem conexão: nenhum teste aqui chega ao banco (falharia ao conectar na porta 1).
const authDb = createDb(`postgresql://app_auth:${'x'.repeat(8)}@127.0.0.1:1/none`, {
  connectionTimeoutMillis: 200,
});
const deps = { appUrl: APP_URL, secret: 's'.repeat(48), authDb };
const auth = createAuth({ ...deps, mailer: createOutboxMailer('/tmp/salon-outbox-unused') });

afterAll(async () => {
  await authDb.$client.end();
});

describe('configuração do Better Auth', () => {
  it('as tabelas do schema auth batem com o que o Better Auth 1.7 espera', async () => {
    const context = await auth.$context;
    expect(context.explicitSchemaCheck).toBeTypeOf('function');
    // Devolve uma Promise na primeira vez e `undefined` quando já conferiu: as duas valem.
    await expect(Promise.resolve(context.explicitSchemaCheck?.())).resolves.toBeUndefined();
  });

  it('o teste de schema reprova uma tabela incompleta (a checagem não é vazia)', async () => {
    const broken = betterAuth({
      baseURL: APP_URL,
      secret: 's'.repeat(48),
      database: drizzleAdapter(authDb, {
        provider: 'pg',
        schema: {
          user: authSessions,
          session: authSessions,
          account: authAccounts,
          verification: authRateLimits,
          rateLimit: authRateLimits,
        },
      }),
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: true, storage: 'database' },
    });
    const context = await broken.$context;
    await expect(Promise.resolve(context.explicitSchemaCheck?.())).rejects.toThrow();
    expect(authUsers).toBeDefined();
  });

  it('cookie de sessão __Host-: Secure, HttpOnly, SameSite=Lax, Path=/, sem Domain', async () => {
    const { authCookies } = await auth.$context;
    expect(authCookies.sessionToken.name).toBe('__Host-salon.session_token');
    expect(authCookies.sessionToken.attributes).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(authCookies.sessionToken.attributes).not.toHaveProperty('domain');
  });

  it('opções de segurança fixadas (ADR-0004 e threat model)', () => {
    const { options } = auth;
    expect(options.baseURL).toBe(APP_URL);
    expect(options.trustedOrigins).toEqual([APP_URL]);
    expect(options.emailAndPassword).toMatchObject({
      requireEmailVerification: true,
      autoSignIn: false,
      disableSignUp: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    });
    // Sem login automático depois de confirmar (pre-account hijacking, LC-06).
    expect(options.emailVerification.autoSignInAfterVerification).toBe(false);
    expect(options.emailVerification.expiresIn).toBeLessThanOrEqual(3600);
    expect(options.session.cookieCache.enabled).toBe(false);
    expect(options.session.expiresIn).toBe(SESSION_MAX_AGE_SECONDS);
    expect(options.rateLimit).toMatchObject({ enabled: true, storage: 'database' });
    expect(options.rateLimit.customRules['/sign-in/email']).toEqual({ window: 60, max: 5 });
    expect(options.advanced.ipAddress.ipAddressHeaders).toEqual(['x-real-ip']);
    const advanced = options.advanced as Record<string, unknown>;
    expect(advanced).not.toHaveProperty('disableCSRFCheck');
    expect(advanced).not.toHaveProperty('disableOriginCheck');
    expect(options.telemetry.enabled).toBe(false);
    expect((options as { plugins?: unknown[] }).plugins ?? []).toEqual([]);
  });

  it('sem provedor de e-mail, o cadastro fica desligado', () => {
    const closed = createAuth({ ...deps, mailer: unavailableMailer });
    expect(closed.options.emailAndPassword.disableSignUp).toBe(true);
  });

  it('toda rota exposta existe na biblioteca (a lista fechada não aponta para o vazio)', () => {
    const paths = new Set(
      Object.values(auth.api).map((endpoint) => (endpoint as { path?: string }).path),
    );
    for (const route of ALLOWED_AUTH_ROUTES) {
      const [, path] = route.split(' ');
      expect(paths.has(path), route).toBe(true);
    }
  });
});

describe('hook before: entrada inválida é recusada antes de consultar o banco', () => {
  const VALID = { name: 'Ana Souza', email: 'ana@example.test', password: 'senha-bem-longa' };

  it.each([
    ['nome com quebra de linha', { ...VALID, name: 'Ana\r\nBcc: x@y' }],
    ['nome vazio', { ...VALID, name: '  ' }],
    ['senha curta', { ...VALID, password: 'curta' }],
    ['campo extra (image)', { ...VALID, image: 'https://evil.example/x.png' }],
    ['campo extra (emailVerified)', { ...VALID, emailVerified: true }],
    ['callbackURL externo', { ...VALID, callbackURL: 'https://evil.example' }],
    ['callbackURL de protocolo relativo', { ...VALID, callbackURL: '//evil.example' }],
  ])('cadastro: %s -> 400 genérico', async (_label, body) => {
    await expect(auth.api.signUpEmail({ body })).rejects.toMatchObject({
      statusCode: 400,
      body: { code: 'INVALID_INPUT' },
    });
  });

  it.each([
    ['campo extra', { email: 'ana@example.test', password: 'x', rememberMe: true }],
    [
      'callbackURL externo',
      { email: 'ana@example.test', password: 'x', callbackURL: '/\\evil.example' },
    ],
  ])('login: %s -> 400 genérico', async (_label, body) => {
    await expect(auth.api.signInEmail({ body })).rejects.toMatchObject({
      statusCode: 400,
      body: { code: 'INVALID_INPUT' },
    });
  });

  it('confirmação: callbackURL diferente do fixo -> 400', async () => {
    await expect(
      auth.api.verifyEmail({ query: { token: 'x', callbackURL: 'https://evil.example' } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(VERIFICATION_CALLBACK_PATH).toBe('/cadastro/confirmado');
  });
});
