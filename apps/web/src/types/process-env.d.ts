// Variáveis lidas em src/env.ts. Declaradas aqui para permitir process.env.NOME (o Next só
// embute variáveis NEXT_PUBLIC_ escritas nessa forma literal) sem conflitar com
// noPropertyAccessFromIndexSignature. O tipo continua string | undefined: quem valida é o Zod.
declare namespace NodeJS {
  interface ProcessEnv {
    readonly APP_ENV?: string;
    readonly NEXT_PUBLIC_APP_URL?: string;
  }
}
