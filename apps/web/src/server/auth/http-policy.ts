import { isIP } from 'node:net';

/**
 * Política HTTP das rotas `/api/auth/*` (threat model LC-02, LC-08, LC-11). Módulo puro,
 * testado sem servidor.
 *
 * - Lista FECHADA de rotas do Better Auth expostas nesta iteração: endpoint novo de uma
 *   atualização da biblioteca (ou de um plugin) responde 404 até alguém decidir expô-lo.
 * - O link de confirmação sempre volta para `VERIFICATION_CALLBACK_PATH` (nada de
 *   `callbackURL` vindo do cliente: open redirect).
 * - IP do cliente só de `x-real-ip` (um valor, sobrescrito pela borda da plataforma; não
 *   verificado na Vercel, ADR-0004). Em preview/production, sem IP válido a requisição é
 *   recusada: sem ele o rate limit cairia num balde compartilhado por todos.
 */

const AUTH_BASE_PATH = '/api/auth';

/** Para onde o link de confirmação de e-mail leva depois de verificar. */
export const VERIFICATION_CALLBACK_PATH = '/cadastro/confirmado';

/** "MÉTODO /caminho" relativo a `AUTH_BASE_PATH`. */
export const ALLOWED_AUTH_ROUTES: ReadonlySet<string> = new Set([
  'POST /sign-up/email',
  'POST /sign-in/email',
  'POST /sign-out',
  'GET /verify-email',
]);

/** Caminho relativo a `/api/auth`, ou `undefined` se a URL não estiver sob ele. */
export function authRoutePath(url: URL): string | undefined {
  if (!url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
    return undefined;
  }
  return url.pathname.slice(AUTH_BASE_PATH.length).replace(/\/+$/, '');
}

export function isAllowedAuthRoute(method: string, url: URL): boolean {
  const path = authRoutePath(url);
  return path !== undefined && ALLOWED_AUTH_ROUTES.has(`${method.toUpperCase()} ${path}`);
}

export const CLIENT_IP_HEADER = 'x-real-ip';

/** O único IP de `x-real-ip`, ou `undefined` se ausente, múltiplo ou malformado. */
export function clientIp(headers: Headers): string | undefined {
  const value = headers.get(CLIENT_IP_HEADER)?.trim();
  if (value === undefined || value === '' || value.includes(',')) {
    return undefined;
  }
  return isIP(value) === 0 ? undefined : value;
}

/** Ambientes publicados: exigem o IP da borda (fail-closed). */
export function requiresClientIp(appEnv: string): boolean {
  return appEnv === 'production' || appEnv === 'preview';
}
