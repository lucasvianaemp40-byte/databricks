import type { AuthResult } from './client';

type Failure = Extract<AuthResult, { ok: false }>;

const TOO_MANY = 'Muitas tentativas em pouco tempo. Aguarde um minuto e tente de novo.';
const OFFLINE = 'Sem conexão com o servidor. Confira sua internet e tente de novo.';
const GENERIC = 'Não foi possível concluir agora. Tente de novo em instantes.';

/**
 * Mensagens do cadastro. Nunca dizem se o e-mail já tem conta: com `requireEmailVerification`
 * o servidor responde igual nos dois casos, e a tela também.
 */
export function signUpErrorMessage(failure: Failure): string {
  if (failure.status === 429) return TOO_MANY;
  if (failure.status === 0) return OFFLINE;
  if (failure.code === 'PASSWORD_TOO_SHORT') return 'A senha precisa ter pelo menos 12 caracteres.';
  if (failure.code === 'PASSWORD_TOO_LONG') return 'A senha pode ter no máximo 128 caracteres.';
  if (failure.status === 400 || failure.status === 422) return 'Revise os dados e tente de novo.';
  return GENERIC;
}

/** Mensagens do login: e-mail e senha errados são indistinguíveis. */
export function signInErrorMessage(failure: Failure): string {
  if (failure.status === 429) return TOO_MANY;
  if (failure.status === 0) return OFFLINE;
  if (failure.code === 'EMAIL_NOT_VERIFIED') {
    return 'Confirme seu e-mail para entrar. Enviamos um novo link para a sua caixa de entrada.';
  }
  if (failure.status === 400 || failure.status === 401) return 'E-mail ou senha incorretos.';
  return GENERIC;
}
