import type { SignInInput, SignUpInput } from '../validation/account';

/**
 * Chamadas do navegador ao Better Auth (`/api/auth/*`), com `fetch` puro: nada de SDK no
 * bundle do cliente. O servidor revalida tudo (hook `before`) e fixa o `callbackURL`.
 */
export type AuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly code: string | undefined };

/** Mesmo valor que o servidor exige (server/auth/http-policy.ts). */
const VERIFICATION_CALLBACK_PATH = '/cadastro/confirmado';

async function post(path: string, body: unknown): Promise<AuthResult> {
  let response: Response;
  try {
    response = await fetch(`/api/auth${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, code: 'NETWORK' };
  }
  if (response.ok) {
    return { ok: true };
  }
  let code: string | undefined;
  try {
    const payload = (await response.json()) as { code?: unknown };
    code = typeof payload.code === 'string' ? payload.code : undefined;
  } catch {
    code = undefined;
  }
  return { ok: false, status: response.status, code };
}

export function signUp(input: SignUpInput): Promise<AuthResult> {
  return post('/sign-up/email', { ...input, callbackURL: VERIFICATION_CALLBACK_PATH });
}

export function signIn(input: SignInInput): Promise<AuthResult> {
  return post('/sign-in/email', { ...input, callbackURL: VERIFICATION_CALLBACK_PATH });
}

export function signOut(): Promise<AuthResult> {
  return post('/sign-out', {});
}
