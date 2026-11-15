import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { echoValues, fieldErrorsFrom, readFields } from './form-state';

describe('estado de formulário', () => {
  it('readFields pega só os campos esperados (campos de framework e extras ficam de fora)', () => {
    const data = new FormData();
    data.set('email', 'ana@exemplo.com');
    data.set('$ACTION_ID_abc', '');
    data.set('role', 'owner');
    expect(readFields(data, ['email', 'password'])).toEqual({
      email: 'ana@exemplo.com',
      password: null,
    });
  });

  it('echoValues nunca devolve a senha e corta valores enormes', () => {
    const values = echoValues<'email' | 'password' | 'name'>(
      { email: 'ana@exemplo.com', password: 'segredo-de-teste-123', name: 'a'.repeat(1000) },
      ['password'],
    );
    expect(values).toEqual({ email: 'ana@exemplo.com', name: 'a'.repeat(300) });
  });

  it('fieldErrorsFrom guarda a primeira mensagem de cada campo', () => {
    const result = z
      .object({
        a: z.string().min(2, { error: 'curto' }).max(1, { error: 'longo' }),
        b: z.string(),
      })
      .safeParse({ a: 'xyz', b: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = fieldErrorsFrom<'a' | 'b'>(result.error);
      expect(errors.a).toBe('longo');
      expect(errors.b).toBeDefined();
    }
  });
});
