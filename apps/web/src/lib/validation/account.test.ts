import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  personNameSchema,
  signInSchema,
  signUpSchema,
} from './account';

const VALID = { name: 'Ana Souza', email: 'ana@example.test', password: 'senha-bem-longa' };

describe('signUpSchema', () => {
  it('aceita nome, e-mail e senha válidos e normaliza o e-mail', () => {
    expect(signUpSchema.parse({ ...VALID, email: '  Ana@Example.TEST ' })).toEqual({
      ...VALID,
      email: 'ana@example.test',
    });
  });

  it(`senha de ${PASSWORD_MIN_LENGTH} a ${PASSWORD_MAX_LENGTH} caracteres, sem regra de composição`, () => {
    expect(signUpSchema.safeParse({ ...VALID, password: 'a'.repeat(11) }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...VALID, password: 'a'.repeat(12) }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...VALID, password: 'a'.repeat(128) }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...VALID, password: 'a'.repeat(129) }).success).toBe(false);
    // Espaços e frases contam: a senha não é aparada.
    expect(signUpSchema.parse({ ...VALID, password: '  frase com espaços  ' }).password).toBe(
      '  frase com espaços  ',
    );
  });

  it('recusa chave extra (mass assignment)', () => {
    expect(signUpSchema.safeParse({ ...VALID, image: 'https://x' }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...VALID, emailVerified: true }).success).toBe(false);
  });

  it('recusa e-mail inválido ou longo demais', () => {
    expect(signUpSchema.safeParse({ ...VALID, email: 'sem-arroba' }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...VALID, email: `${'a'.repeat(250)}@x.test` }).success).toBe(
      false,
    );
  });
});

describe('personNameSchema (nome que vai para e-mail e tela)', () => {
  it('apara e normaliza para NFC', () => {
    expect(personNameSchema.parse('  José  ')).toBe('José');
  });

  it.each([
    ['vazio', '   '],
    ['longo demais', 'a'.repeat(121)],
    ['quebra de linha (injeção em e-mail)', 'Ana\r\nBcc: x@y'],
    ['caractere de controle', 'Ana\u0000'],
    // biome-ignore lint/security/noSecrets: texto de teste com caractere bidi escapado, não é segredo.
    ['override bidi', 'Ana\u202Eetnaigrev'],
    ['isolador bidi', 'Ana\u2066x'],
    ['espaço de largura zero', 'An\u200Ba'],
    ['BOM', '\uFEFFAna'],
  ])('recusa %s', (_label, value) => {
    expect(personNameSchema.safeParse(value).success).toBe(false);
  });

  it('aceita acentos, apóstrofo e hífen', () => {
    expect(personNameSchema.parse("Maria D'Ávila-Souza")).toBe("Maria D'Ávila-Souza");
  });
});

describe('signInSchema', () => {
  it('aceita e-mail e qualquer senha não vazia até o máximo (sem revelar a regra de cadastro)', () => {
    expect(signInSchema.parse({ email: 'ANA@example.test', password: 'x' })).toEqual({
      email: 'ana@example.test',
      password: 'x',
    });
    expect(signInSchema.safeParse({ email: 'ana@example.test', password: '' }).success).toBe(false);
    expect(
      signInSchema.safeParse({ email: 'ana@example.test', password: 'a'.repeat(129) }).success,
    ).toBe(false);
  });
});
