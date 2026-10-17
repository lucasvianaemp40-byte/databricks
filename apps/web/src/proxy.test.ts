import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { isValidNonce } from './lib/security/nonce';
import { config, proxy } from './proxy';

/** Cabeçalhos de requisição que o Proxy repassa ao renderizador (x-middleware-request-*). */
function forwardedRequestHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

function nonceFrom(csp: string | null): string | undefined {
  return csp?.match(/'nonce-([^']+)'/)?.[1];
}

describe('proxy', () => {
  it('aplica a mesma CSP com nonce na resposta e na requisição repassada ao Next', () => {
    const response = proxy(new NextRequest('http://localhost/'));
    const responseCsp = response.headers.get('content-security-policy');
    const nonce = nonceFrom(responseCsp);

    expect(nonce).toBeDefined();
    expect(isValidNonce(nonce ?? '')).toBe(true);
    expect(forwardedRequestHeader(response, 'content-security-policy')).toBe(responseCsp);
    expect(forwardedRequestHeader(response, 'x-nonce')).toBe(nonce);
  });

  it('gera um nonce novo a cada requisição', () => {
    const nonces = Array.from({ length: 50 }, () =>
      nonceFrom(proxy(new NextRequest('http://localhost/')).headers.get('content-security-policy')),
    );
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it('descarta x-nonce e CSP enviados pelo cliente', () => {
    const forged = new NextRequest('http://localhost/', {
      headers: {
        'x-nonce': 'AAAAAAAAAAAAAAAAAAAAAA==',
        'content-security-policy': "script-src 'nonce-AAAAAAAAAAAAAAAAAAAAAA=='",
      },
    });
    const response = proxy(forged);
    const nonce = nonceFrom(response.headers.get('content-security-policy'));

    expect(nonce).not.toBe('AAAAAAAAAAAAAAAAAAAAAA==');
    expect(forwardedRequestHeader(response, 'x-nonce')).toBe(nonce);
    expect(forwardedRequestHeader(response, 'content-security-policy')).not.toContain(
      'AAAAAAAAAAAAAAAAAAAAAA==',
    );
  });

  it('preserva os demais cabeçalhos da requisição', () => {
    const response = proxy(
      new NextRequest('http://localhost/', { headers: { 'accept-language': 'pt-BR' } }),
    );
    expect(forwardedRequestHeader(response, 'accept-language')).toBe('pt-BR');
  });

  it('usa a política estrita fora de NODE_ENV=development', () => {
    // O Vitest roda com NODE_ENV=test: precisa cair na política de produção.
    const csp = proxy(new NextRequest('http://localhost/')).headers.get('content-security-policy');
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('cobre páginas e /api, mas não os assets estáticos com hash', () => {
    const [matcher] = config.matcher;
    // eslint-disable-next-line security/detect-non-literal-regexp -- padrão constante do próprio proxy.ts, não vem de entrada externa.
    const source = new RegExp(`^${matcher?.source ?? ''}$`);
    for (const path of ['/', '/api/health', '/salao/agendar', '/rota-inexistente']) {
      expect(source.test(path), path).toBe(true);
    }
    for (const path of ['/_next/static/chunks/app.js', '/_next/image', '/favicon.ico']) {
      expect(source.test(path), path).toBe(false);
    }
  });
});
