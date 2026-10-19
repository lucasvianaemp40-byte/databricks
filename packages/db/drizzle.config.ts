import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit só GERA migrações a partir do schema (não precisa de banco).
 * Aplicação: `pnpm --filter @salon/db migrate` (src/migrate.ts), nunca `drizzle-kit push`
 * nem `drizzle-kit migrate`: o runner próprio troca para o papel `app_migrator`, serializa
 * execuções concorrentes e recusa migração já aplicada que foi alterada.
 *
 * Fluxo para mudar o schema (migrações são imutáveis depois de commitadas):
 *   1. altere src/schema/*.ts
 *   2. pnpm --filter @salon/db generate --name=<descricao>
 *   3. RLS/GRANTs/EXCLUDE/triggers de tabela nova: pnpm --filter @salon/db generate:custom <nome>
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  schemaFilter: ['app'],
  migrations: {
    schema: 'drizzle',
    table: '__drizzle_migrations',
  },
  breakpoints: true,
  strict: true,
  verbose: true,
});
