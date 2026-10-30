import 'server-only';
import {
  authAccounts,
  authRateLimits,
  authSessions,
  authUsers,
  authVerifications,
  type Database,
} from '@salon/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { z } from 'zod';
import {
  emailSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  personNameSchema,
  signUpSchema,
} from '../../lib/validation/account';
import type { Mailer } from '../mail/mailer';
import { verificationEmail } from '../mail/verification-email';
import { CLIENT_IP_HEADER, VERIFICATION_CALLBACK_PATH } from './http-policy';
import { authLogger } from './logger';

/**
 * Better Auth da equipe do salão (ADR-0004, threat model 2026-10-20).
 *
 * - E-mail e senha (12 a 128), e-mail confirmado antes do acesso, resposta igual para e-mail
 *   novo ou já cadastrado (`requireEmailVerification`). Sem login automático depois de
 *   confirmar (LC-06, pre-account hijacking): a pessoa entra com a própria senha.
 * - Cookie `__Host-salon.session_token` (Secure, HttpOnly, SameSite=Lax, Path=/, sem Domain),
 *   sem `cookieCache` (sessão revogada não sobrevive em cache).
 * - Sessão de 12 h, sem renovação deslizante nesta iteração (teto absoluto de 12 h).
 * - Rate limit no banco (`auth.rate_limits`) por `x-real-ip`.
 * - `baseURL`/`trustedOrigins` fixos em `APP_URL`: o link de confirmação nunca usa o Host
 *   da requisição (LC-07).
 * - Validação estrita no hook `before`, ANTES da busca pelo e-mail: entrada inválida responde
 *   igual exista ou não a conta (LC-03). O `databaseHooks` repete a regra do nome.
 * - Organização (plugin `organization`) desligada: o salão é criado por `provisionTenant`.
 */

export interface AuthDependencies {
  readonly appUrl: string;
  readonly secret: string;
  /** Conexão do papel `app_auth`. */
  readonly authDb: Database;
  readonly mailer: Mailer;
}

/** Sessão: 12 h a partir do login (sem renovação deslizante). */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Prefixo `__Host-`: só funciona com Secure, Path=/ e sem Domain (ver o ADR-0004). */
const SESSION_COOKIE_PREFIX = '__Host-salon';

const INVALID_INPUT = { code: 'INVALID_INPUT', message: 'Dados inválidos.' } as const;

/** Corpo aceito em `/sign-up/email`: o do formulário mais o `callbackURL` fixo. */
const signUpBodySchema = signUpSchema.extend({ callbackURL: z.string().optional() });

/** Corpo aceito em `/sign-in/email`. */
const signInBodySchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  callbackURL: z.string().optional(),
});

function rejectInvalidInput(): never {
  throw new APIError('BAD_REQUEST', INVALID_INPUT);
}

/** O cliente não escolhe para onde o link de confirmação leva (LC-08). */
function fixedCallbackURL(value: string | undefined): string {
  if (value !== undefined && value !== VERIFICATION_CALLBACK_PATH) {
    rejectInvalidInput();
  }
  return VERIFICATION_CALLBACK_PATH;
}

/**
 * Validação do hook `before` (LC-03, LC-08): devolve o corpo normalizado de cadastro e login,
 * ou `undefined` quando a rota não tem corpo a trocar. Entrada inválida lança 400 genérico.
 */
function validateRequest(
  path: string,
  body: unknown,
  query: unknown,
): Record<string, unknown> | undefined {
  if (path === '/sign-up/email') {
    const parsed = signUpBodySchema.safeParse(body);
    if (!parsed.success) {
      rejectInvalidInput();
    }
    return { ...parsed.data, callbackURL: fixedCallbackURL(parsed.data.callbackURL) };
  }
  if (path === '/sign-in/email') {
    const parsed = signInBodySchema.safeParse(body);
    if (!parsed.success) {
      rejectInvalidInput();
    }
    return { ...parsed.data, callbackURL: fixedCallbackURL(parsed.data.callbackURL) };
  }
  if (path === '/verify-email') {
    const parsed = z
      .object({ token: z.string().min(1).max(4096), callbackURL: z.string() })
      .safeParse(query);
    if (!parsed.success || parsed.data.callbackURL !== VERIFICATION_CALLBACK_PATH) {
      rejectInvalidInput();
    }
  }
  return undefined;
}

export function createAuth(deps: AuthDependencies) {
  return betterAuth({
    appName: 'Agenda Salão',
    baseURL: deps.appUrl,
    basePath: '/api/auth',
    secret: deps.secret,
    trustedOrigins: [deps.appUrl],
    telemetry: { enabled: false },
    logger: authLogger,
    database: drizzleAdapter(deps.authDb, {
      provider: 'pg',
      transaction: true,
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        rateLimit: authRateLimits,
      },
    }),
    emailAndPassword: {
      enabled: true,
      // Sem provedor de e-mail (preview/production nesta iteração), ninguém confirmaria o
      // cadastro: desligado, sem conta presa e sem diferença de resposta (LC-15).
      disableSignUp: !deps.mailer.available,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      // Login de conta não confirmada reenvia o link (no lugar de um endpoint de reenvio).
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      async sendVerificationEmail({ user, url }) {
        await deps.mailer.send({ to: user.email, ...verificationEmail({ name: user.name, url }) });
      },
    },
    // Identificador de verificação gravado com hash (ADR-0004): nada de e-mail em claro ali.
    verification: { storeIdentifier: 'hashed' },
    session: {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      updateAge: SESSION_MAX_AGE_SECONDS,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 60 * 60, max: 5 },
        '/verify-email': { window: 60, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: false,
      cookiePrefix: SESSION_COOKIE_PREFIX,
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
      database: { generateId: 'uuid' },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    databaseHooks: {
      session: {
        create: {
          // O Better Auth grava o User-Agent e o IP sem cortar: valor gigante violaria o
          // CHECK do banco e derrubaria o login com 500. Corta nos limites do schema.
          before(session) {
            return Promise.resolve({
              data: {
                ...session,
                userAgent: session.userAgent?.slice(0, 1024) ?? null,
                ipAddress: session.ipAddress?.slice(0, 64) ?? null,
              },
            });
          },
        },
      },
      user: {
        create: {
          // Segunda camada: o nome já passou pelo hook `before`.
          before(user) {
            const name = personNameSchema.safeParse(user.name);
            if (!name.success) {
              rejectInvalidInput();
            }
            return Promise.resolve({ data: { ...user, name: name.data } });
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware((ctx) => {
        const body = validateRequest(ctx.path, ctx.body, ctx.query);
        // Corpo validado e normalizado substitui o recebido (o Better Auth mescla `context`).
        return Promise.resolve(body === undefined ? undefined : { context: { body } });
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
