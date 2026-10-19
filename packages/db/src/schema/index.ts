/**
 * Schema Drizzle do @salon/db. Fonte para `drizzle-kit generate` (drizzle.config.ts) e para
 * o cliente tipado. O que o Drizzle não modela (EXCLUDE, FORCE RLS, políticas, triggers,
 * GRANTs, papéis) está nas migrações custom em `drizzle/`.
 */
export * from './appointments';
export * from './availability';
// drizzle-kit só emite CREATE SCHEMA para objetos pgSchema exportados pelo schema.
export { appSchema } from './columns';
export * from './customers';
export * from './locations';
export * from './services';
export * from './staff';
export * from './tenants';
