import { defineConfig } from 'vitest/config';

// Domínio puro: só ambiente Node, sem banco nem rede. Testes ficam ao lado do código
// (*.test.ts = exemplos, *.prop.test.ts = propriedades) e em test/ (suporte e meta-testes).
export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Instabilidade em teste puro é bug (relógio, ordem, aleatoriedade sem semente).
    retry: 0,
    tags: [
      {
        name: 'property',
        description: 'Propriedades com fast-check (FC_NUM_RUNS controla o volume).',
        timeout: 180_000,
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        lines: 95,
        branches: 90,
        functions: 95,
        statements: 95,
        // O domínio é o núcleo de risco: cada arquivo precisa cumprir o piso, não só a média.
        perFile: true,
      },
    },
  },
});
