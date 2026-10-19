import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
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
});

/**
 * Matcher compilado pelas regras do próprio Next (path-to-regexp, sufixos .rsc/.json e
 * `has`/`missing`), não como regex crua: um lookahead sem âncora ou um '.' sem escape no
 * `source` só aparecem assim.
 */
function proxyRuns(url: string, headers: Record<string, string> = {}): boolean {
  return unstable_doesMiddlewareMatch({ config, url, headers });
}

describe('matcher do proxy', () => {
  it.each([
    '/',
    '/api/health',
    '/salao/agendar',
    '/rota-inexistente',
    '/icon.svg',
    // Documentos HTML (404 do app) que escapavam do matcher antigo por prefixo ou por '.'.
    '/favicon.ico',
    '/favicon.ico.bak',
    '/faviconXico',
    '/favicon.icoanything/abc',
    '/_next/static',
    '/_next/staticX',
    '/_next/static-evil/page',
    '/_next/imagefoo',
    // O otimizador de imagens está desligado: /_next/image responde a página 404 do app.
    '/_next/image',
    // A futura página pública /[slug] não pode perder a CSP por causa do slug do salão.
    '/favicon-ico-studio',
    '/next-static-barbearia',
  ])('roda em %s', (path) => {
    expect(proxyRuns(`http://localhost${path}`)).toBe(true);
  });

  it.each([
    '/_next/static/chunks/app.js',
    '/_next/static/css/app.css',
    '/_next/static/media/fonte.woff2',
  ])('não roda nos assets estáticos com hash (%s)', (path) => {
    expect(proxyRuns(`http://localhost${path}`)).toBe(false);
  });

  it.each([
    ['next-router-prefetch', '1'],
    ['next-router-prefetch', 'qualquer-valor'],
    ['purpose', 'prefetch'],
    ['sec-purpose', 'prefetch'],
  ])('roda mesmo com o cabeçalho %s: %s (o cliente controla esses cabeçalhos)', (name, value) => {
    expect(proxyRuns('http://localhost/', { [name]: value })).toBe(true);
  });
});
