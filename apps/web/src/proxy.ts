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
      // Tudo, inclusive /api, exceto os assets com hash DENTRO de /_next/static/ (não são
      // documentos; um arquivo ausente ali devolve 404 text/plain, sem HTML). A barra final no
      // lookahead é obrigatória: sem ela, /_next/staticX, /_next/static-evil/… e um futuro
      // /[slug] com esse prefixo escapariam do Proxy. Nada de '.' sem escape nem exclusões por
      // prefixo solto (o antigo `favicon.ico` deixava /favicon-ico-studio sem CSP).
      // /_next/image fica coberto: com `images.unoptimized` ele responde a página 404 do app.
      // Sem `missing` para prefetch: next-router-prefetch e purpose são cabeçalhos que o
      // cliente controla, e com eles o HTML completo sairia sem CSP. Um nonce por prefetch
      // custa pouco (toda página já é dinâmica).
      source: '/((?!_next/static/).*)',
    },
  ],
};
