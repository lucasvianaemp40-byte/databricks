/**
 * Campos de texto de um FormData, sem os campos internos do React/Next (`$ACTION_*`). Devolve
 * `null` se houver arquivo ou chave repetida: o schema estrito decide o resto (chave extra
 * reprova, LC-20).
 */
export function formFields(formData: FormData): Record<string, string> | null {
  const fields: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('$ACTION')) {
      continue;
    }
    if (typeof value !== 'string' || Object.hasOwn(fields, key)) {
      return null;
    }
    fields[key] = value;
  }
  return fields;
}
