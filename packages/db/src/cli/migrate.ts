/**
 * CLI: `pnpm --filter @salon/db migrate`
 *
 * Lê a URL de `DATABASE_URL_MIGRATOR` (superusuário em dev/CI; em produção, o admin do
 * provedor com CREATEROLE e SET no papel app_migrator). Nunca use a URL do app_user aqui.
 * Saída: 0 sucesso, 1 falha, 64 uso incorreto.
 */
import { runMigrations } from '../migrate';

// Executado fora do turbo (pnpm --filter @salon/db migrate): não entra no cache de tarefas.
const { DATABASE_URL_MIGRATOR: databaseUrl } = process.env;

if (databaseUrl === undefined || databaseUrl === '') {
  console.error('[migrate] defina DATABASE_URL_MIGRATOR (conexão de superusuário/admin).');
  process.exitCode = 64;
} else {
  try {
    const result = await runMigrations({
      databaseUrl,
      log: (message) => {
        console.log(`[migrate] ${message}`);
      },
    });
    if (result.applied.length > 0) {
      console.log(`[migrate] aplicadas: ${result.applied.join(', ')}`);
    }
  } catch (error) {
    // Só a mensagem: a URL (com senha) nunca vai para o log.
    console.error(`[migrate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
