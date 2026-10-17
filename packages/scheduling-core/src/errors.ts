/**
 * Entrada inválida para uma função do domínio: dado corrompido ou erro de integração
 * (a validação de formulário acontece antes, na borda). Traz o campo ofensor para log e
 * para mapear a resposta HTTP 400/422 sem analisar a mensagem.
 */
export class SchedulingInputError extends RangeError {
  // biome-ignore lint/security/noSecrets: nome da classe de erro, não é segredo.
  override readonly name = 'SchedulingInputError';
  readonly field: string;

  constructor(field: string, message: string, options?: ErrorOptions) {
    super(`${field}: ${message}`, options);
    this.field = field;
  }
}

/** Exige inteiro seguro dentro de [min, max]. */
export function assertIntegerInRange(field: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new SchedulingInputError(
      field,
      `esperado inteiro entre ${min} e ${max}, recebido ${String(value)}`,
    );
  }
}
