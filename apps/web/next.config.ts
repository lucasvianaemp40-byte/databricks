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
  // Otimizador de imagens DESLIGADO enquanto o app não usa next/image: /_next/image responde
  // 404 e o sharp/libvips sai do caminho das requisições (alvo de advisories de SSRF, DoS e
  // RCE via decodificadores). `remotePatterns: []` não bastava: já é o padrão do Next e o
  // endpoint continuava buscando qualquer caminho local. Ao religar, use `localPatterns`
  // restrito, `qualities` e `formats` mínimos e `remotePatterns` só com um caso de uso real.
  images: { unoptimized: true },
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
