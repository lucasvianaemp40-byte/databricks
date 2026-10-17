import type { NextConfig } from 'next';
// Valida as variáveis de ambiente ao carregar a config: `next build`, `next dev` e
// `next start` falham no boot se alguma for inválida.
import './src/env';
import { staticSecurityHeaders } from './src/lib/security/headers';

const isProductionBuild = process.env.NODE_ENV === 'production';

const nextConfig: NextConfig = {
  // Não anuncia o framework (X-Powered-By).
  poweredByHeader: false,
  reactStrictMode: true,
  // Links tipados: <Link href> só aceita rotas que existem (estável no Next 16).
  typedRoutes: true,
  // Pacotes internos exportam o fonte TypeScript, sem build próprio. O Turbopack já transpila
  // pacotes do workspace; a lista explícita mantém o comportamento se o build usar webpack.
  transpilePackages: ['@salon/scheduling-core'],
  // Sem otimização de imagens remotas até existir um caso de uso (reduz a superfície de SSRF
  // e DoS do otimizador, alvo de vários advisories do Next).
  images: { remotePatterns: [] },
  // Cache Components (PPR) é incompatível com CSP por nonce: toda página é dinâmica.
  cacheComponents: false,
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [...staticSecurityHeaders({ includeHsts: isProductionBuild })],
      },
    ]);
  },
};

export default nextConfig;
