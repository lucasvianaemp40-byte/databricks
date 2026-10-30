import { z } from 'zod';
import { displayText } from './text';

/**
 * Regras da conta da equipe (ADR-0004, ASVS 6.2.1/6.2.9): senha de 12 a 128 caracteres, sem
 * regra de composição e sem aparar (frases com espaço valem). Os mesmos limites estão na
 * configuração do Better Auth (`server/auth/config.ts`). Módulo puro: o formulário do
 * navegador e o hook do servidor usam os mesmos schemas.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
/** RFC 5321: o caminho inteiro do endereço cabe em 254 caracteres. */
const EMAIL_MAX_LENGTH = 254;

export const personNameSchema = displayText({ min: 1, max: 120 });

export const emailSchema = z
  .string({ error: 'Informe o e-mail.' })
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .email({ error: 'Informe um e-mail válido.' })
      .max(EMAIL_MAX_LENGTH, { error: 'Informe um e-mail válido.' }),
  );

const newPasswordSchema = z
  .string({ error: 'Informe a senha.' })
  .min(PASSWORD_MIN_LENGTH, { error: `Use pelo menos ${PASSWORD_MIN_LENGTH} caracteres.` })
  .max(PASSWORD_MAX_LENGTH, { error: `Use no máximo ${PASSWORD_MAX_LENGTH} caracteres.` });

export const signUpSchema = z.strictObject({
  name: personNameSchema,
  email: emailSchema,
  password: newPasswordSchema,
});
export type SignUpInput = z.infer<typeof signUpSchema>;

/** No login, só o teto: a regra de cadastro não é revelada a quem tenta senhas. */
export const signInSchema = z.strictObject({
  email: emailSchema,
  password: z
    .string({ error: 'Informe a senha.' })
    .min(1, { error: 'Informe a senha.' })
    .max(PASSWORD_MAX_LENGTH, { error: 'E-mail ou senha incorretos.' }),
});
export type SignInInput = z.infer<typeof signInSchema>;
