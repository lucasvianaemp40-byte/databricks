// Variáveis lidas em src/env.ts e src/server/env.ts. Declaradas aqui para permitir process.env.NOME sem conflitar
// com noPropertyAccessFromIndexSignature. O tipo continua string | undefined: quem valida é o
// Zod. Variáveis de servidor (APP_ENV, APP_URL) são lidas em runtime; só as NEXT_PUBLIC_
// escritas nessa forma literal seriam substituídas pelo valor do build.
declare namespace NodeJS {
  interface ProcessEnv {
    readonly APP_ENV?: string;
    readonly APP_URL?: string;
    readonly DATABASE_URL?: string;
    readonly DATABASE_URL_AUTH?: string;
    readonly BETTER_AUTH_SECRET?: string;
    readonly MAIL_OUTBOX_DIR?: string;
    /** Definida pelo Next: 'nodejs' ou 'edge' (instrumentation.ts). */
    readonly NEXT_RUNTIME?: string;
  }
}
