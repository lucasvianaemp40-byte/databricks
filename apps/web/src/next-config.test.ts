import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('next.config', () => {
  it('desliga o otimizador de imagens enquanto o app não usa next/image', () => {
    // `remotePatterns: []` já é o padrão do Next e NÃO desliga /_next/image: o endpoint
    // continua buscando qualquer caminho local e passando a resposta pelo sharp/libvips.
    // Só `unoptimized: true` faz o servidor responder 404 ali.
    expect(nextConfig.images?.unoptimized).toBe(true);
  });

  it('rotas de autenticação saem com Referrer-Policy no-referrer, depois da regra global', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const global = rules.findIndex((rule) => rule.source === '/:path*');
    const auth = rules.findIndex((rule) => rule.source === '/api/auth/:path*');
    expect(global).toBeGreaterThanOrEqual(0);
    // No Next, entre regras que casam com o mesmo caminho, a ÚLTIMA define o valor da chave.
    expect(auth).toBeGreaterThan(global);
    expect(rules[auth]?.headers).toEqual([{ key: 'Referrer-Policy', value: 'no-referrer' }]);
  });

  it('não anuncia o framework (X-Powered-By)', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
