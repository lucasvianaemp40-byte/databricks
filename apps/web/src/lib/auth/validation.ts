/**
 * Validação (zod estrito) das entradas de cadastro, login e criação do salão. Os limites
 * repetem os CHECKs do banco e a política do ADR-0004 (senha de 12 a 128 caracteres).
 * Puro: sem I/O, testado em validation.test.ts. As actions montam o objeto só com os campos
 * esperados do FormData, e o `.strict()` recusa qualquer outro (id, role, tenant...).
 */
import { z } from 'zod';
import { isBrazilTimeZone } from '../time-zones';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
const NAME_MAX_LENGTH = 120;
/** RFC 5321: caminho de e-mail com no máximo 254 caracteres. */
const EMAIL_MAX_LENGTH = 254;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
/** 8 dígitos seguidos ou mais: telefone ou CPF no endereço público (dado pessoal na URL). */
const LONG_DIGIT_RUN = /\d{8,}/;
/** Caminhos do próprio sistema que um salão não pode ocupar na URL pública. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'ajuda',
  'api',
  'app',
  'auth',
  'cadastro',
  'conta',
  'configuracoes',
  'entrar',
  'favicon',
  'icon',
  'login',
  'logout',
  'novo',
  'painel',
  'manifest',
  'privacidade',
  'robots',
  'sair',
  'salao',
  'signup',
  'sitemap',
  'static',
  'suporte',
  'termos',
  'www',
]);

const name = (label: string) =>
  z
    .string({ error: `Informe ${label}.` })
    .trim()
    .min(1, { error: `Informe ${label}.` })
    .max(NAME_MAX_LENGTH, { error: `Use no máximo ${NAME_MAX_LENGTH} caracteres.` });

const email = z
  .string({ error: 'Informe o e-mail.' })
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH, { error: 'E-mail longo demais.' })
  .pipe(z.email({ error: 'Informe um e-mail válido.' }));

export const signUpSchema = z
  .object({
    name: name('seu nome'),
    email,
    // Sem trim: espaços fazem parte da senha.
    password: z
      .string({ error: 'Informe a senha.' })
      .min(PASSWORD_MIN_LENGTH, {
        error: `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`,
      })
      .max(PASSWORD_MAX_LENGTH, {
        error: `A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`,
      }),
  })
  .strict();

export const signInSchema = z
  .object({
    email,
    password: z
      .string({ error: 'Informe a senha.' })
      .min(1, { error: 'Informe a senha.' })
      .max(PASSWORD_MAX_LENGTH, { error: 'E-mail ou senha incorretos.' }),
  })
  .strict();

export const createSalonSchema = z
  .object({
    salonName: name('o nome do salão'),
    slug: z
      .string({ error: 'Informe o endereço.' })
      .trim()
      .regex(SLUG_PATTERN, {
        error: 'Use de 3 a 63 letras minúsculas, números ou hífens, sem hífen no começo ou no fim.',
      })
      .refine((value) => !LONG_DIGIT_RUN.test(value), {
        error: 'Não use telefone, CPF ou outro número longo no endereço.',
      })
      .refine((value) => !RESERVED_SLUGS.has(value), {
        error: 'Este endereço é reservado. Escolha outro.',
      }),
    locationName: name('o nome da unidade'),
    timezone: z
      .string({ error: 'Escolha o fuso.' })
      .refine(isBrazilTimeZone, { error: 'Escolha um fuso da lista.' }),
  })
  .strict();

/** Sugestão de endereço a partir do nome: sem acento, minúsculas e hífens, até 63. */
export function suggestSlug(salonName: string): string {
  return salonName
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}
