import { defineConfig } from 'vitest/config';

/**
 * Dois projetos Vitest no mesmo pacote:
 *
 * - `db:unit` (`pnpm test`): sem banco, rápido, faz parte do gate local (`pnpm verify`).
 * - `db:integration` (`pnpm test:db`): PostgreSQL REAL. TEST_DATABASE_URL (superusuário) vem
 *   do CI ou de scripts/with-local-postgres.sh. O global setup cria um banco descartável,
 *   aplica as migrações com o runner de produção e entrega URLs dos papéis app_user e
 *   app_worker (NOSUPERUSER, NOBYPASSRLS, não-donos). Sem paralelismo entre arquivos: há
 *   testes de corrida (EXCLUDE) e de catálogo que observam o banco inteiro; o pool `forks`
 *   isola cada arquivo em processo próprio.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'db:unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/*.rls.test.ts'],
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
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
