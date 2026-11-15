/**
 * Mensagens de erro mostradas ao usuário nas telas de conta e de criação do salão. Sempre
 * fixas: nunca a mensagem, o código, a stack ou dados do erro original (threat model A8 e
 * A11). Login e cadastro não distinguem "e-mail existe" de "não existe".
 */
import { APIError } from 'better-auth/api';

export type AuthErrorContext = 'sign-in' | 'sign-up' | 'create-salon';

export const GENERIC_SIGN_IN_ERROR = 'E-mail ou senha incorretos.';
export const GENERIC_SIGN_UP_ERROR =
  'Não foi possível criar a conta com esses dados. Confira e tente de novo, ou entre se já tiver conta.';
const GENERIC_CREATE_SALON_ERROR = 'Não foi possível criar o salão agora. Tente de novo.';
export const SLUG_TAKEN_ERROR = 'Este endereço já está em uso por outro salão. Escolha outro.';
export const TOO_MANY_ATTEMPTS =
  'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.';

const GENERIC: Readonly<Record<AuthErrorContext, string>> = {
  'sign-in': GENERIC_SIGN_IN_ERROR,
  'sign-up': GENERIC_SIGN_UP_ERROR,
  'create-salon': GENERIC_CREATE_SALON_ERROR,
};

const SLUG_TAKEN_CODES: ReadonlySet<string> = new Set([
  'ORGANIZATION_SLUG_ALREADY_TAKEN',
  'ORGANIZATION_ALREADY_EXISTS',
]);

export function authErrorMessage(error: unknown, context: AuthErrorContext): string {
  if (error instanceof APIError) {
    if (error.status === 'TOO_MANY_REQUESTS') {
      return TOO_MANY_ATTEMPTS;
    }
    const code = typeof error.body?.code === 'string' ? error.body.code : '';
    if (context === 'create-salon' && SLUG_TAKEN_CODES.has(code)) {
      return SLUG_TAKEN_ERROR;
    }
  }
  return GENERIC[context];
}
