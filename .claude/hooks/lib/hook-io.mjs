// @ts-check
/**
 * Entrada e saída dos hooks do Claude Code (JSON no stdin, decisão no stdout).
 * Referência: https://code.claude.com/docs/en/hooks
 */
import { readFileSync } from 'node:fs';

/**
 * Lê o JSON do hook no stdin. Entrada vazia vira `{}`; JSON inválido lança erro, e o
 * chamador decide se isso bloqueia (guardas) ou é ignorado (hooks de qualidade).
 * @returns {Record<string, any>}
 */
export function readHookInput() {
  const raw = readFileSync(0, 'utf8');
  if (raw.trim() === '') return {};
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('a entrada do hook não é um objeto JSON');
  }
  return parsed;
}

/**
 * Escreve a decisão de um PreToolUse. `deny` bloqueia a ferramenta (o motivo vai para o
 * Claude); `ask` pede confirmação humana (o motivo aparece no prompt).
 * @param {'deny' | 'ask'} decision
 * @param {string} reason
 */
function writePreToolUseDecision(decision, reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}

/**
 * Executa um guarda de PreToolUse em modo fail-closed: qualquer exceção vira `deny`
 * com o motivo, mesmo em versões do Claude Code sem `onFailure: "block"`.
 * @param {string} name prefixo das mensagens, ex.: `guard-bash`
 * @param {(input: Record<string, any>) => { decision: 'deny' | 'ask' | null, reasons: string[] }} evaluate
 */
export function runPreToolUseGuard(name, evaluate) {
  let result;
  try {
    result = evaluate(readHookInput());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writePreToolUseDecision(
      'deny',
      `[${name}] Falha interna do hook (fail-closed): ${message}. Corrija o hook em .claude/hooks/ ou peça ajuda a um humano.`,
    );
    process.exitCode = 0;
    return;
  }
  if (result.decision) {
    const reasons = [...new Set(result.reasons)];
    writePreToolUseDecision(result.decision, `[${name}] ${reasons.join(' | ')}`);
  }
  process.exitCode = 0;
}
