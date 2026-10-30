import 'server-only';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * Variáveis SÓ do servidor (banco e autenticação), separadas de `src/env.ts`.
 *
 * Por que separadas: o `next.config.ts` importa `src/env.ts` também no `next build`, e o build
 * não deve precisar de segredo nem de banco (nada aqui vai para o bundle). Estas são
 * validadas no BOOT do servidor (`src/instrumentation.ts`, `next start`/`next dev`) e de novo,
 * por segurança, no primeiro uso. Mensagens citam o nome e a regra, nunca o valor recebido.
 *
 * Para adicionar uma variável: schema aqui, `src/types/process-env.d.ts`, `turbo.json` do
 * pacote e `.env.example`.
 */

const APP_ENVIRONMENTS = ['development', 'test', 'e2e', 'preview', 'production'] as const;
/** Ambientes em que o outbox de e-mail em arquivo é permitido (nunca preview/production). */
const OUTBOX_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'test', 'e2e']);
/** Valor de exemplo do `.env.example`: copiado sem trocar, vira segredo conhecido. */
const EXAMPLE_SECRET = 'troque-por-um-segredo-aleatorio-de-32-bytes-ou-mais';
const POSTGRES_URL = /^postgres(?:ql)?:\/\/[^\s]+$/;

const optional = (schema: z.ZodType<string>) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const schema = z
  .object({
    APP_ENV: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(APP_ENVIRONMENTS, { error: 'valor inválido' }).default('development'),
    ),
    /** Papel `app_user` (requisições web, dados de tenant com RLS). */
    DATABASE_URL: z
      .string({ error: 'obrigatória (URL postgres:// do papel app_user)' })
      .regex(POSTGRES_URL, { error: 'use uma URL postgres:// ou postgresql://' }),
    /** Papel `app_auth` (Better Auth e criação do salão). */
    DATABASE_URL_AUTH: z
      .string({ error: 'obrigatória (URL postgres:// do papel app_auth)' })
      .regex(POSTGRES_URL, { error: 'use uma URL postgres:// ou postgresql://' }),
    /** Assina sessões e links de verificação. */
    BETTER_AUTH_SECRET: z
      .string({ error: 'obrigatório (gere com `openssl rand -base64 32`)' })
      .min(32, { error: 'use pelo menos 32 caracteres aleatórios' })
      .refine((value) => value !== EXAMPLE_SECRET, {
        error: 'troque o valor de exemplo por um segredo aleatório',
      }),
    /** Pasta onde o envio de e-mail grava as mensagens (só dev/test/e2e). */
    MAIL_OUTBOX_DIR: optional(z.string().refine(isAbsolute, { error: 'use um caminho absoluto' })),
  })
  .superRefine((values, ctx) => {
    if (values.DATABASE_URL === values.DATABASE_URL_AUTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL_AUTH'],
        message: 'precisa ser a conexão do papel app_auth, diferente de DATABASE_URL',
      });
    }
    if (values.MAIL_OUTBOX_DIR !== undefined && !OUTBOX_ENVIRONMENTS.has(values.APP_ENV)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_OUTBOX_DIR'],
        message: 'o outbox em arquivo só vale com APP_ENV development, test ou e2e',
      });
    }
  });

type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export interface ServerEnv {
  readonly appEnv: AppEnvironment;
  readonly databaseUrl: string;
  readonly databaseUrlAuth: string;
  readonly betterAuthSecret: string;
  readonly mailOutboxDir: string | undefined;
}

export class ServerEnvError extends Error {
  override readonly name = 'ServerEnvError';
}

type ServerEnvName =
  | 'NODE_ENV'
  | 'APP_ENV'
  | 'DATABASE_URL'
  | 'DATABASE_URL_AUTH'
  | 'BETTER_AUTH_SECRET'
  | 'MAIL_OUTBOX_DIR';
type RuntimeServerEnv = Readonly<Partial<Record<ServerEnvName, string | undefined>>>;

/** Valida um conjunto de variáveis (exportado para os testes; o app usa `serverEnv()`). */
export function parseServerEnv(runtime: RuntimeServerEnv): ServerEnv {
  // No servidor de produção, APP_ENV ausente cairia em `development` e desligaria o IP
  // obrigatório e a recusa do outbox: precisa ser explícita.
  if (runtime.NODE_ENV === 'production' && (runtime.APP_ENV ?? '') === '') {
    throw new ServerEnvError(
      'Variáveis de servidor inválidas (veja apps/web/.env.example):\n- APP_ENV: obrigatória no servidor de produção (production, preview ou e2e)',
    );
  }
  const result = schema.safeParse({
    APP_ENV: runtime.APP_ENV,
    DATABASE_URL: runtime.DATABASE_URL,
    DATABASE_URL_AUTH: runtime.DATABASE_URL_AUTH,
    BETTER_AUTH_SECRET: runtime.BETTER_AUTH_SECRET,
    MAIL_OUTBOX_DIR: runtime.MAIL_OUTBOX_DIR,
  });
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `- ${issue.path.map(String).join('.') || '(ambiente)'}: ${issue.message}`,
    );
    throw new ServerEnvError(
      `Variáveis de servidor inválidas (veja apps/web/.env.example):\n${lines.join('\n')}`,
    );
  }
  const values = result.data;
  return {
    appEnv: values.APP_ENV,
    databaseUrl: values.DATABASE_URL,
    databaseUrlAuth: values.DATABASE_URL_AUTH,
    betterAuthSecret: values.BETTER_AUTH_SECRET,
    mailOutboxDir: values.MAIL_OUTBOX_DIR,
  };
}

let cached: ServerEnv | undefined;

/** Variáveis do servidor validadas uma vez por processo. Lança se faltar ou sobrar algo. */
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv({
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_AUTH: process.env.DATABASE_URL_AUTH,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    MAIL_OUTBOX_DIR: process.env.MAIL_OUTBOX_DIR,
  });
  return cached;
}
