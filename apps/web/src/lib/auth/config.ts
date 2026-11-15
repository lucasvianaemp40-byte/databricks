/**
 * Opções do Better Auth (ADR-0004), sem I/O: o servidor monta a instância em `server.ts` e
 * os testes conferem estas opções (config.test.ts), inclusive o drift contra a migração do
 * schema auth (`packages/db/drizzle/0006_auth_schema.sql`).
 *
 * Esta é a 1ª entrega (threat model 2026-10-30-conta-e-salao): ainda sem segundo fator,
 * verificação de e-mail, HIBP e limite de tentativas próprio. Por isso `assertAuthAllowed`
 * recusa `APP_ENV=production` (A1) até a 2ª entrega.
 */
import type { BetterAuthOptions, GenericEndpointContext, Session } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { organization } from 'better-auth/plugins';
import type pg from 'pg';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './validation';

/** Prefixo dos cookies: `__Host-` exige Secure, Path=/ e nenhum Domain (ASVS 3.3.3). */
export const SESSION_COOKIE_PREFIX = '__Host-salao';

const DAY_SECONDS = 24 * 60 * 60;

export class AuthNotAllowedInProductionError extends Error {
  readonly code = 'AUTH_NOT_ALLOWED_IN_PRODUCTION';

  constructor() {
    super(
      'Autenticação bloqueada em produção até a 2ª entrega do ADR-0004 (segundo fator, ' +
        'verificação de e-mail, HIBP e limite de tentativas).',
    );
    this.name = new.target.name;
  }
}

/** Ambientes em que esta entrega pode rodar: lista fechada (o resto, inclusive o desconhecido, não). */
const AUTH_ALLOWED_APP_ENVS: ReadonlySet<string> = new Set([
  'development',
  'test',
  'e2e',
  'preview',
]);

/**
 * Trava de produção (threat model A1), falhando fechado. Recebe o APP_ENV CRU (antes do
 * padrão "development" da validação): um build de produção (`NODE_ENV=production`) sem
 * APP_ENV explícito é tratado como produção, não como desenvolvimento.
 */
export function assertAuthAllowed(appEnv: string | undefined, nodeEnv: string): void {
  const explicit = appEnv === undefined || appEnv === '' ? undefined : appEnv;
  const allowed =
    explicit === undefined ? nodeEnv !== 'production' : AUTH_ALLOWED_APP_ENVS.has(explicit);
  if (!allowed) {
    throw new AuthNotAllowedInProductionError();
  }
}

export interface AuthConfigInput {
  /** Origem pública (APP_URL): base das URLs e única origem confiável. */
  readonly baseURL: string;
  readonly secret: string;
  /** Pool do papel app_auth com search_path=auth. */
  readonly database: pg.Pool;
}

export function buildAuthOptions(input: AuthConfigInput) {
  return {
    appName: 'Agenda Salão',
    baseURL: input.baseURL,
    secret: input.secret,
    database: input.database,
    // Só a própria origem. Nunca disableCSRFCheck nem disableOriginCheck (ADR-0004).
    trustedOrigins: [input.baseURL],
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      autoSignIn: true,
    },
    session: {
      expiresIn: 7 * DAY_SECONDS,
      updateAge: DAY_SECONDS,
      // Sem cache no cookie: sessão revogada deixa de valer na hora (ADR-0004).
      cookieCache: { enabled: false },
    },
    advanced: {
      // A organização é o tenant: id uuid, igual ao de app.tenants.
      database: { generateId: 'uuid' },
      // `__Host-` à mão: com useSecureCookies o Better Auth prefixaria `__Secure-` também.
      useSecureCookies: false,
      cookiePrefix: SESSION_COOKIE_PREFIX,
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
      // Minimização (LGPD): a sessão não guarda IP enquanto a tela de sessões ativas não existe.
      ipAddress: { disableIpTracking: true },
    },
    databaseHooks: {
      session: {
        create: {
          /**
           * Sessão nova (login) já aponta para o salão do usuário: a organização ativa é por
           * sessão, e sem isto quem entra de novo cairia na criação do salão. Um salão por
           * conta nesta entrega, então o vínculo é único. O DAL continua conferindo o membro
           * a cada requisição; isto só escolhe o salão, não autoriza nada.
           */
          before: async (session: Session, context: GenericEndpointContext | null) => {
            if (context === null) {
              return undefined;
            }
            const member = await context.context.adapter.findOne<{ organizationId: string }>({
              model: 'member',
              where: [{ field: 'userId', value: session.userId }],
            });
            return member === null
              ? undefined
              : { data: { ...session, activeOrganizationId: member.organizationId } };
          },
        },
      },
    },
    plugins: [
      // Um salão por conta nesta entrega; quem cria a organização é o owner.
      organization({ organizationLimit: 1, creatorRole: 'owner' }),
      // Por último: aplica os Set-Cookie das chamadas feitas dentro de Server Actions.
      nextCookies(),
    ],
  } satisfies BetterAuthOptions;
}
