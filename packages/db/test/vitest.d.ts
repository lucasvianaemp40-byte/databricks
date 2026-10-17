import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Banco descartável desta execução, como superusuário (catálogo, sabotagem controlada). */
    adminDatabaseUrl: string;
    /** Mesmo banco como app_user (papel das requisições web). */
    appUserDatabaseUrl: string;
    /** Mesmo banco como app_worker (papel dos jobs). */
    appWorkerDatabaseUrl: string;
    /** TEST_DATABASE_URL original: para criar bancos de rascunho (testes do runner). */
    maintenanceDatabaseUrl: string;
  }
}
