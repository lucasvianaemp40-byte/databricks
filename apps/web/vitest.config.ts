import { configDefaults, defineConfig } from 'vitest/config';

// Unit do app (sem navegador, sem servidor). Os *.spec.ts de e2e/ são do Playwright e ficam
// fora daqui de propósito: os dois runners não podem disputar os mesmos arquivos.
export default defineConfig({
  test: {
    name: 'web',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    unstubEnvs: true,
    // .only quebra a suíte também fora do CI (o padrão do Vitest é !CI). src/test-hygiene
    // fixa esta config e recusa testes pulados, pendentes ou focados em src/ e e2e/.
    allowOnly: false,
    // Ordem aleatória de arquivos e testes: dependência de ordem vira falha visível. O Vitest
    // imprime a seed; `pnpm --filter @salon/web test --sequence.seed=<n>` reproduz a ordem.
    sequence: { shuffle: true },
    // Portão pelo RESULTADO (test-support/vitest-no-disabled-tests-reporter.ts, na raiz, o mesmo
    // do core e do db): além dos reporters padrão (default ou minimal, e github-actions no CI),
    // reprova a execução se algum teste terminar pulado, pendente ou com falha esperada,
    // qualquer que seja a sintaxe (opção em variável, spread, pulo computado). Em execução
    // filtrada (-t, arquivo:linha) só os testes selecionados contam, e um --reporter na linha
    // de comando substitui esta lista. Só o Vitest: os E2E do Playwright não passam por aqui.
    // Caminho relativo a este app.
    reporters: [
      ...configDefaults.reporters,
      '../../test-support/vitest-no-disabled-tests-reporter.ts',
    ],
  },
});
