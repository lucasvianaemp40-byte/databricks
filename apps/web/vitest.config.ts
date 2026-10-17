import { defineConfig } from 'vitest/config';

// Unit do app (sem navegador, sem servidor). Os *.spec.ts de e2e/ são do Playwright e ficam
// fora daqui de propósito: os dois runners não podem disputar os mesmos arquivos.
export default defineConfig({
  test: {
    name: 'web',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    unstubEnvs: true,
  },
});
