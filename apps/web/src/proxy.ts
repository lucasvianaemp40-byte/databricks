/**
 * Proxy do Next 16 (antigo middleware): gera um nonce por requisição e aplica a CSP.
 *
 * O Proxy NÃO é camada de autorização. Ele foi burlado várias vezes em 2025–2026 (por exemplo
 * GHSA-f82v-jwr5-mffw e os lotes do Next 16.2.5/16.2.11), e um matcher alterado tira a cobertura
 * de rotas e Server Functions sem aviso. Autenticação e autorização acontecem dentro de cada
 * Server Action, Route Handler e na camada de acesso a dados. Aqui só entram cabeçalhos e,
 * no futuro, redirecionamentos de conveniência.
 *
 * Como o nonce chega aos scripts: o Next lê o 'nonce-…' do cabeçalho Content-Security-Policy
 * da REQUISIÇÃO durante a renderização e o aplica aos próprios scripts. Por isso as páginas
 * precisam de renderização dinâmica (o layout raiz chama connection()).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { env } from './env';
import { buildContentSecurityPolicy } from './lib/security/csp';
import { generateNonce, NONCE_REQUEST_HEADER } from './lib/security/nonce';

const CSP_HEADER = 'Content-Security-Policy';

export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    // Relaxa só com NODE_ENV=development explícito; qualquer outro valor usa a política estrita.
    mode: env.NODE_ENV === 'development' ? 'development' : 'production',
  });

  // `set` sobrescreve valores que o cliente tenha enviado nesses cabeçalhos.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_REQUEST_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER, csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Tudo, inclusive /api, exceto assets estáticos com hash (não são documentos e não
      // executam no contexto da página). Prefetches do <Link> não precisam de nonce novo.
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
