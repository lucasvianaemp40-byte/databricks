/**
 * Variáveis de ambiente validadas com Zod (@t3-oss/env-nextjs).
 *
 * - Falha no boot: o next.config.ts importa este módulo, então `next build`, `next dev` e
 *   `next start` abortam se alguma variável for inválida. Nada de app rodando com config errada.
 * - Separação servidor/cliente: variáveis de `server` nunca vão para o bundle do navegador;
 *   ler uma delas em código de cliente lança erro. Só as prefixadas com NEXT_PUBLIC_ (`client`)
 *   são embutidas no bundle, e por isso nunca podem conter segredos.
 * - Mensagens de erro citam o nome da variável e a regra, nunca o valor recebido (pode ser um
 *   segredo quando entrarem DATABASE_URL e afins).
 *
 * Para adicionar uma variável: declare o schema aqui, repasse em `runtimeEnvFrom`, declare-a em
 * apps/web/turbo.json (modo estrito de env do Turborepo) e documente em apps/web/.env.example.
 */
import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/** Ambiente de implantação. Diferente de NODE_ENV: um build de produção roda em e2e e preview. */
const APP_ENVIRONMENTS = ['development', 'test', 'e2e', 'preview', 'production'] as const;

const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Aceita só uma origem http(s): sem caminho, query, fragmento ou credenciais. */
function isBareOrigin(value: string): boolean {
  // No Zod 4 os checks seguintes rodam mesmo após falha de formato: não presuma URL válida.
  const url = URL.parse(value);
  return (
    url !== null &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    !value.endsWith('/')
  );
}

const server = {
  APP_ENV: z
    .enum(APP_ENVIRONMENTS, { error: `use um destes valores: ${APP_ENVIRONMENTS.join(', ')}` })
    .default('development'),
};

const client = {
  NEXT_PUBLIC_APP_URL: z
    .url({ protocol: /^https?$/, error: 'use uma URL http(s) absoluta' })
    .refine(isBareOrigin, {
      error: 'use só a origem, sem caminho, barra final, query, fragmento ou credenciais',
    })
    .default('http://localhost:3000'),
};

const shared = {
  NODE_ENV: z
    .enum(NODE_ENVIRONMENTS, { error: `use um destes valores: ${NODE_ENVIRONMENTS.join(', ')}` })
    .default('development'),
};

type EnvShape = typeof server & typeof client & typeof shared;

/** Regras que cruzam variáveis. Só no servidor: no cliente APP_ENV não existe. */
function createFinalSchema(shape: EnvShape, isServer: boolean) {
  return z.object(shape).superRefine((values, ctx) => {
    if (!isServer || values.APP_ENV !== 'production') {
      return;
    }
    const appUrl = URL.parse(values.NEXT_PUBLIC_APP_URL);
    if (appUrl?.protocol !== 'https:' || LOCAL_HOSTNAMES.has(appUrl.hostname)) {
      ctx.addIssue({
        code: 'custom',
        path: ['NEXT_PUBLIC_APP_URL'],
        message: 'com APP_ENV=production, defina a origem pública em https',
      });
    }
  });
}

/** Erro de configuração com a lista de variáveis inválidas (sem os valores). */
export class InvalidEnvironmentError extends Error {
  override readonly name = 'InvalidEnvironmentError';
}

function failOnInvalidEnvironment(
  issues: ReadonlyArray<{
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
  }>,
): never {
  const lines = issues.map((issue) => {
    const variable = (issue.path ?? [])
      .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
      .join('.');
    return `- ${variable || '(ambiente)'}: ${issue.message}`;
  });
  throw new InvalidEnvironmentError(
    `Variáveis de ambiente inválidas (veja apps/web/.env.example):\n${lines.join('\n')}`,
  );
}

/** Nomes que o app lê do ambiente. */
export type RuntimeEnv = Readonly<
  Record<'APP_ENV' | 'NEXT_PUBLIC_APP_URL' | 'NODE_ENV', string | undefined>
>;

export interface CreateAppEnvOptions {
  /** Força o modo servidor/cliente (testes). Padrão: `typeof window === 'undefined'`. */
  readonly isServer?: boolean;
}

/** Valida um conjunto de variáveis. Exportado para os testes; o app usa `env`. */
export function createAppEnv(runtimeEnv: RuntimeEnv, options: CreateAppEnvOptions = {}) {
  return createEnv({
    server,
    client,
    shared,
    // Cópia: com emptyStringAsUndefined a biblioteca apaga chaves vazias do objeto recebido.
    runtimeEnv: { ...runtimeEnv },
    emptyStringAsUndefined: true,
    createFinalSchema,
    onValidationError: failOnInvalidEnvironment,
    ...(options.isServer === undefined ? {} : { isServer: options.isServer }),
  });
}

/**
 * Acesso literal a process.env.NOME: o Next só embute no bundle do cliente as variáveis
 * NEXT_PUBLIC_ escritas assim (análise estática).
 */
export const env = createAppEnv({
  APP_ENV: process.env.APP_ENV,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NODE_ENV: process.env.NODE_ENV,
});
