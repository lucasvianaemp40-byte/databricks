import { configDefaults, defineConfig } from 'vitest/config';

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
    // .only quebra a suíte também fora do CI (o padrão do Vitest é !CI). test/test-hygiene
    // fixa esta config e recusa dicas de exclusão de cobertura e testes pulados no código.
    allowOnly: false,
    // Arquivos e testes em ordem aleatória: teste que depende de ordem ou de estado deixado
    // por outro falha. O Vitest imprime a semente ("Running tests with seed"); reproduza com
    // `pnpm --filter @salon/scheduling-core test --sequence.seed=<semente>`.
    sequence: { shuffle: true },
    // Portão pelo RESULTADO (test-support/vitest-no-disabled-tests-reporter.ts, na raiz, o mesmo
    // do @salon/db e do @salon/web): além dos reporters padrão (default ou minimal, e
    // github-actions no CI), reprova a execução se algum teste terminar pulado, pendente ou com
    // falha esperada, qualquer que seja a sintaxe (opção em variável, spread, biome-ignore...).
    // Em execução filtrada (-t, arquivo:linha) só os testes selecionados contam, e um
    // --reporter na linha de comando substitui esta lista. Caminho relativo a este pacote.
    reporters: [
      ...configDefaults.reporters,
      '../../test-support/vitest-no-disabled-tests-reporter.ts',
    ],
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
