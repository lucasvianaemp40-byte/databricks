import { describe, expect, it } from 'vitest';
import {
  ALLOWED_AUTH_ROUTES,
  authRoutePath,
  clientIp,
  isAllowedAuthRoute,
  requiresClientIp,
} from './http-policy';

const at = (path: string) => new URL(`http://127.0.0.1:3100${path}`);

describe('rotas do Better Auth expostas (lista fechada)', () => {
  it('libera só cadastro, login, logout e o link de confirmação', () => {
    expect([...ALLOWED_AUTH_ROUTES].sort()).toEqual([
      'GET /verify-email',
      'POST /sign-in/email',
      'POST /sign-out',
      'POST /sign-up/email',
    ]);
    expect(isAllowedAuthRoute('POST', at('/api/auth/sign-in/email'))).toBe(true);
    expect(isAllowedAuthRoute('get', at('/api/auth/verify-email'))).toBe(true);
  });

  it.each([
    ['GET', '/api/auth/sign-in/email'],
    ['POST', '/api/auth/verify-email'],
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/send-verification-email'],
    ['POST', '/api/auth/update-user'],
    ['POST', '/api/auth/change-email'],
    ['POST', '/api/auth/delete-user'],
    ['POST', '/api/auth/request-password-reset'],
    ['POST', '/api/auth/organization/create'],
    ['GET', '/api/auth/list-sessions'],
    ['GET', '/api/auth/ok'],
    ['GET', '/api/auth/error'],
    ['POST', '/api/auth/sign-in/social'],
    ['POST', '/api/auth/sign-up/email/../../update-user'],
  ])('recusa %s %s', (method, path) => {
    expect(isAllowedAuthRoute(method, at(path))).toBe(false);
  });

  it('aceita barra final e ignora a query; fora de /api/auth não é rota de auth', () => {
    expect(authRoutePath(at('/api/auth/sign-out/'))).toBe('/sign-out');
    expect(isAllowedAuthRoute('GET', at('/api/auth/verify-email?token=x'))).toBe(true);
    expect(authRoutePath(at('/api/authx/sign-out'))).toBeUndefined();
  });
});

describe('IP do cliente (x-real-ip)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['2001:db8::1', '2001:db8::1'],
  ])('aceita %s', (value, ip) => {
    expect(clientIp(new Headers({ 'x-real-ip': value }))).toBe(ip);
  });

  it.each([
    ['ausente', undefined],
    ['vazio', ''],
    ['lista (proxy encadeado ou forjado)', '203.0.113.7, 10.0.0.1'],
    ['malformado', '999.1.1.1'],
    ['texto', 'localhost'],
    ['IPv6 inválido', '::::'],
    ['IPv6 com lixo', '2001:db8::zz'],
  ])('recusa %s', (_label, value) => {
    const headers = new Headers(value === undefined ? {} : { 'x-real-ip': value });
    expect(clientIp(headers)).toBeUndefined();
  });

  it('ignora x-forwarded-for (só a borda escreve x-real-ip)', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7' }))).toBeUndefined();
  });

  it('exige o IP só em preview e production', () => {
    expect(requiresClientIp('production')).toBe(true);
    expect(requiresClientIp('preview')).toBe(true);
    expect(requiresClientIp('e2e')).toBe(false);
    expect(requiresClientIp('development')).toBe(false);
  });
});
