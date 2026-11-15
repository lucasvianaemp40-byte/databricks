/**
 * Estado devolvido pelas Server Actions de formulário (useActionState). Só texto fixo e os
 * valores não secretos que o usuário digitou (nunca a senha), para reexibir o formulário.
 */
import type { z } from 'zod';

export interface FormState<Field extends string> {
  /** Mensagem geral (erro de servidor ou credenciais), já pronta para exibir. */
  readonly message?: string;
  readonly fieldErrors?: Partial<Record<Field, string>>;
  readonly values?: Partial<Record<Field, string>>;
}

/** Primeira mensagem de cada campo de um erro do zod. */
export function fieldErrorsFrom<Field extends string>(
  error: z.ZodError,
): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && !(field in errors)) {
      errors[field as Field] = issue.message;
    }
  }
  return errors;
}

/** Lê os campos de texto esperados do FormData (o resto é ignorado; o zod é estrito). */
export function readFields<Field extends string>(
  formData: FormData,
  fields: readonly Field[],
): Record<Field, FormDataEntryValue | null> {
  return Object.fromEntries(fields.map((field) => [field, formData.get(field)])) as Record<
    Field,
    FormDataEntryValue | null
  >;
}

/** Valores para reexibir: só strings, nunca os campos marcados como secretos. */
export function echoValues<Field extends string>(
  raw: Record<Field, FormDataEntryValue | null>,
  secret: readonly Field[] = [],
): Partial<Record<Field, string>> {
  const values: Partial<Record<Field, string>> = {};
  for (const [field, value] of Object.entries(raw) as [Field, FormDataEntryValue | null][]) {
    if (typeof value === 'string' && !secret.includes(field)) {
      values[field] = value.slice(0, 300);
    }
  }
  return values;
}
