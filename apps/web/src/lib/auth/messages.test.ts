import { APIError } from 'better-auth/api';
import { describe, expect, it } from 'vitest';
import { authErrorMessage, GENERIC_SIGN_IN_ERROR, GENERIC_SIGN_UP_ERROR } from './messages';

const apiError = (
  status: 'UNAUTHORIZED' | 'BAD_REQUEST' | 'UNPROCESSABLE_ENTITY' | 'TOO_MANY_REQUESTS',
  code: string,
) => new APIError(status, { message: `detalhe interno ${code} maria@exemplo.com`, code });

describe('mensagens de erro de conta e salão', () => {
  it('login: e-mail inexistente e senha errada dão a MESMA mensagem (sem enumeração)', () => {
    expect(authErrorMessage(apiError('UNAUTHORIZED', 'INVALID_EMAIL_OR_PASSWORD'), 'sign-in')).toBe(
      GENERIC_SIGN_IN_ERROR,
    );
    expect(authErrorMessage(apiError('BAD_REQUEST', 'INVALID_EMAIL'), 'sign-in')).toBe(
      GENERIC_SIGN_IN_ERROR,
    );
  });

  it('cadastro: e-mail já usado não é revelado', () => {
    for (const code of ['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL']) {
      expect(authErrorMessage(apiError('UNPROCESSABLE_ENTITY', code), 'sign-up')).toBe(
        GENERIC_SIGN_UP_ERROR,
      );
    }
  });

  it('muitas tentativas viram aviso de espera', () => {
    expect(authErrorMessage(apiError('TOO_MANY_REQUESTS', 'TOO_MANY_REQUESTS'), 'sign-in')).toMatch(
      /Muitas tentativas/,
    );
  });

  it('endereço do salão em uso é dito (o slug é público)', () => {
    expect(
      authErrorMessage(apiError('BAD_REQUEST', 'ORGANIZATION_SLUG_ALREADY_TAKEN'), 'create-salon'),
    ).toMatch(/endereço já está em uso/);
    expect(
      authErrorMessage(apiError('BAD_REQUEST', 'ORGANIZATION_ALREADY_EXISTS'), 'create-salon'),
    ).toMatch(/endereço já está em uso/);
  });

  it('nunca repassa a mensagem, o código interno, stack ou PII do erro original', () => {
    const errors = [
      apiError('BAD_REQUEST', 'QUALQUER_COISA'),
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=xyz'),
      'texto solto',
      undefined,
    ];
    for (const error of errors) {
      for (const context of ['sign-in', 'sign-up', 'create-salon'] as const) {
        const message = authErrorMessage(error, context);
        expect(message).not.toMatch(/maria@|ECONNREFUSED|password|QUALQUER|detalhe interno/);
        expect(message.length).toBeGreaterThan(0);
      }
    }
  });
});
