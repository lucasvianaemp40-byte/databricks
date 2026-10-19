import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Dois projetos Vitest no mesmo pacote:
 *
 * - `db:unit` (`pnpm test`): sem banco, rápido, faz parte do gate local (`pnpm verify`).
 *   Inclui os meta-testes de test/ (higiene da suíte), menos os de integração.
 * - `db:integration` (`pnpm test:db`): PostgreSQL REAL. TEST_DATABASE_URL (superusuário) vem
 *   do CI ou de scripts/with-local-postgres.sh. O global setup cria um banco descartável,
 *   aplica as migrações com o runner de produção e entrega URLs dos papéis app_user e
 *   app_worker (NOSUPERUSER, NOBYPASSRLS, não-donos). Sem paralelismo entre arquivos: há
 *   testes de corrida (EXCLUDE) e de catálogo que observam o banco inteiro; o pool `forks`
 *   isola cada arquivo em processo próprio.
 *
 * Ordem aleatória nos dois projetos. A integração também embaralha: cada arquivo cria os
 * próprios tenants no beforeAll e cada teste usa dia/horário próprio (contadores ou datas
 * distintas), então a ordem não importa por construção; o embaralhamento é o que impede um
 * acoplamento novo de passar despercebido. A ordem dos ARQUIVOS vem do sequenciador da raiz
 * (global) e importa na integração, que roda um arquivo por vez. A semente aparece no
 * cabeçalho da execução ("Running tests with seed"); reproduza com --sequence.seed=<semente>.
 *
 * `allowOnly: false`: sem isto o Vitest só recusa .only quando CI está definido (a sessão local
 * não tem). `retry: 0`: instabilidade é bug, não se repete até passar. test/test-hygiene.test.ts
 * fixa esta config e recusa testes focados, pulados ou pendentes no código.
 *
 * Portão pelo RESULTADO (test-support/vitest-no-disabled-tests-reporter.ts, na raiz, o mesmo do
 * core e do web), na raiz da config, para os dois projetos: além dos reporters padrão (default
 * ou minimal, e github-actions no CI), reprova `pnpm test` e `pnpm test:db` se algum teste
 * terminar pulado, pendente ou com falha esperada, qualquer que seja a sintaxe (opção em
 * variável, spread, pulo computado). Em execução filtrada (-t, arquivo:linha) só os testes
 * selecionados contam, e um --reporter na linha de comando substitui esta lista. Caminho
 * relativo a este pacote.
 */
export default defineConfig({
  test: {
    sequence: { shuffle: { files: true, tests: true } },
    reporters: [
      ...configDefaults.reporters,
      '../../test-support/vitest-no-disabled-tests-reporter.ts',
    ],
    projects: [
      {
        test: {
          name: 'db:unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/*.rls.test.ts'],
          allowOnly: false,
          retry: 0,
          sequence: { shuffle: true },
        },
      },
      {
        test: {
          name: 'db:integration',
          environment: 'node',
          include: ['test/**/*.int.test.ts', 'test/**/*.rls.test.ts'],
          globalSetup: ['./test/global-setup.ts'],
          pool: 'forks',
          fileParallelism: false,
          allowOnly: false,
          retry: 0,
          sequence: { shuffle: true },
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
