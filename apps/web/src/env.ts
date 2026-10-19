/**
 * Variáveis de ambiente validadas com Zod (@t3-oss/env-nextjs).
 *
 * - Falha no boot: o next.config.ts importa este módulo, então `next build`, `next dev` e
 *   `next start` abortam se alguma variável for inválida. Nada de app rodando com config errada.
 * - Variáveis de `server` são lidas em RUNTIME (o Next não as embute) e nunca vão para o
 *   navegador; ler uma delas em código de cliente lança erro. A validação do boot e o valor que
 *   o servidor usa são, portanto, sempre os mesmos.
 * - Variáveis NEXT_PUBLIC_ (`client`) são embutidas pelo `next build` em TODOS os bundles,
 *   inclusive o do servidor: o valor de runtime é ignorado e mudar exige novo build. Por isso
 *   nunca contêm segredos e só existem quando o código de CLIENTE precisa delas. Hoje não há
 *   nenhuma: a origem pública (APP_URL) só é usada no servidor.
 * - Mensagens de erro citam o nome da variável e a regra, nunca o valor recebido (pode ser um
 *   segredo quando entrarem DATABASE_URL e afins).
 *
 * Para adicionar uma variável: declare o schema aqui, repasse em `env` (fim do arquivo) e em
 * RuntimeEnv, declare-a em src/types/process-env.d.ts e em apps/web/turbo.json (modo estrito
 * de env do Turborepo) e documente em apps/web/.env.example.
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
  /**
   * Origem pública do app (metadataBase: URLs absolutas de canonical, Open Graph etc.). É de
   * servidor de propósito: como NEXT_PUBLIC_ ela era embutida no build, e um build iniciado
   * com outra configuração (e2e promovido a produção) passava na validação do boot e
   * respondia 500 em toda rota, ou usava a origem do build sem avisar.
   */
  APP_URL: z
    .url({ protocol: /^https?$/, error: 'use uma URL http(s) absoluta' })
    .refine(isBareOrigin, {
      error: 'use só a origem, sem caminho, barra final, query, fragmento ou credenciais',
    })
    .default('http://localhost:3000'),
};

/** Nenhuma variável de cliente por enquanto (ver o comentário do topo antes de criar uma). */
const client = {};

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
    const appUrl = URL.parse(values.APP_URL);
    if (appUrl?.protocol !== 'https:' || LOCAL_HOSTNAMES.has(appUrl.hostname)) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
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
export type RuntimeEnv = Readonly<Record<'APP_ENV' | 'APP_URL' | 'NODE_ENV', string | undefined>>;

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
 * Acesso literal a process.env.NOME. Para variáveis de servidor ele vira leitura em runtime;
 * o Next só substitui pelo valor do build as NEXT_PUBLIC_ (e NODE_ENV) escritas assim.
 */
export const env = createAppEnv({
  APP_ENV: process.env.APP_ENV,
  APP_URL: process.env.APP_URL,
  NODE_ENV: process.env.NODE_ENV,
});
