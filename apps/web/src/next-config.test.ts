import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('next.config', () => {
  it('desliga o otimizador de imagens enquanto o app não usa next/image', () => {
    // `remotePatterns: []` já é o padrão do Next e NÃO desliga /_next/image: o endpoint
    // continua buscando qualquer caminho local e passando a resposta pelo sharp/libvips.
    // Só `unoptimized: true` faz o servidor responder 404 ali.
    expect(nextConfig.images?.unoptimized).toBe(true);
  });

  it('não anuncia o framework (X-Powered-By)', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
