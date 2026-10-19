import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/migrate';
import {
  createScratchDatabase,
  dropDatabase,
  randomSecret,
  setRolePassword,
  withCredentials,
  withDatabase,
} from './helpers/database-admin';

/**
 * Prepara o PostgreSQL dos testes de integração:
 *   1. cria um banco descartável a partir de TEST_DATABASE_URL (superusuário);
 *   2. aplica as migrações com o MESMO runner de produção (papéis, RLS, invariantes);
 *   3. define senhas aleatórias para app_user/app_worker e entrega as URLs aos testes;
 *   4. ao final, apaga o banco.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { TEST_DATABASE_URL: maintenanceUrl } = process.env;
  if (maintenanceUrl === undefined || maintenanceUrl === '') {
    throw new Error(
      'TEST_DATABASE_URL ausente. Rode `pnpm test:db` (sobe um PostgreSQL efêmero via ' +
        'scripts/with-local-postgres.sh) ou exporte a URL de um superusuário de um cluster de TESTE.',
    );
  }

  const database = await createScratchDatabase(maintenanceUrl, 'salon_test');
  const adminUrl = withDatabase(maintenanceUrl, database);
  try {
    await runMigrations({ databaseUrl: adminUrl });
    const appUserPassword = randomSecret();
    const appWorkerPassword = randomSecret();
    await setRolePassword(adminUrl, 'app_user', appUserPassword);
    await setRolePassword(adminUrl, 'app_worker', appWorkerPassword);

    project.provide('maintenanceDatabaseUrl', maintenanceUrl);
    project.provide('adminDatabaseUrl', adminUrl);
    project.provide('appUserDatabaseUrl', withCredentials(adminUrl, 'app_user', appUserPassword));
    project.provide(
      'appWorkerDatabaseUrl',
      withCredentials(adminUrl, 'app_worker', appWorkerPassword),
    );
  } catch (error) {
    await dropDatabase(maintenanceUrl, database);
    throw error;
  }

  return async () => {
    await dropDatabase(maintenanceUrl, database);
  };
}
