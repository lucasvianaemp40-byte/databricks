import { z } from 'zod';

/**
 * Caracteres proibidos em nomes que aparecem em tela e em e-mail (ASVS 1.3.11): controle
 * (inclusive CR/LF, que injetariam cabeçalho), overrides e isoladores bidi (texto que se lê
 * ao contrário) e caracteres de largura zero e BOM (nomes visualmente iguais a outros).
 * Conferidos no texto RECEBIDO, antes de aparar: um CR no fim ou um BOM no começo também
 * recusam (sinal de colagem adulterada ou automação), em vez de sumirem em silêncio.
 */
const FORBIDDEN_CHARACTERS = /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;

/** Texto curto de exibição: sem os caracteres acima, normalizado para NFC e aparado. */
export function displayText(options: { readonly min: number; readonly max: number }) {
  return z
    .string({ error: 'Preencha este campo.' })
    .refine((value) => !FORBIDDEN_CHARACTERS.test(value), {
      error: 'Remova caracteres especiais invisíveis ou de controle.',
    })
    .transform((value) => value.normalize('NFC').trim())
    .pipe(
      z
        .string()
        .min(options.min, { error: `Use pelo menos ${options.min} caracteres.` })
        .max(options.max, { error: `Use no máximo ${options.max} caracteres.` }),
    );
}
