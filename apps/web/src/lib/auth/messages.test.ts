import { describe, expect, it } from 'vitest';
import { signInErrorMessage, signUpErrorMessage } from './messages';

const fail = (status: number, code?: string) => ({ ok: false as const, status, code });

describe('mensagens de erro de autenticação', () => {
  it('login: e-mail inexistente e senha errada dão a mesma mensagem', () => {
    expect(signInErrorMessage(fail(401, 'INVALID_EMAIL_OR_PASSWORD'))).toBe(
      'E-mail ou senha incorretos.',
    );
    expect(signInErrorMessage(fail(400, 'INVALID_INPUT'))).toBe('E-mail ou senha incorretos.');
  });

  it('login de conta não confirmada orienta a abrir o novo link', () => {
    expect(signInErrorMessage(fail(403, 'EMAIL_NOT_VERIFIED'))).toMatch(/novo link/);
  });

  it('limite de tentativas e falta de conexão', () => {
    expect(signInErrorMessage(fail(429))).toMatch(/Aguarde um minuto/);
    expect(signUpErrorMessage(fail(429))).toMatch(/Aguarde um minuto/);
    expect(signUpErrorMessage(fail(0, 'NETWORK'))).toMatch(/Sem conexão/);
  });

  it('cadastro nunca menciona conta já existente', () => {
    for (const failure of [fail(400), fail(422), fail(500), fail(422, 'USER_ALREADY_EXISTS')]) {
      expect(signUpErrorMessage(failure)).not.toMatch(/existe|cadastrad/i);
    }
  });
});
