#!/usr/bin/env node
// @ts-check
/**
 * UserPromptSubmit: bloqueia um prompt que parece conter segredo colado (chave, token,
 * URL de banco com senha). O texto não chega ao modelo e a mensagem de bloqueio omite o
 * prompt (`suppressOriginalPrompt`). Atenção: o Claude Code ainda pode gravar o texto no
 * histórico local; se o segredo vazou, rotacione-o.
 *
 * Não usa `onFailure: "block"`: um erro aqui não deve travar a sessão inteira. Em vez
 * disso, falhas ficam visíveis no stderr e o prompt segue.
 */
import process from 'node:process';
import { readHookInput } from './lib/hook-io.mjs';
import { findSecretInText } from './lib/secret-patterns.mjs';

try {
  const input = readHookInput();
  const kind = findSecretInText(typeof input.prompt === 'string' ? input.prompt : '');
  if (kind) {
    process.stdout.write(
      `${JSON.stringify({
        decision: 'block',
        reason: `Prompt bloqueado: parece conter ${kind}. Não cole segredos no chat; cite o NOME da variável de ambiente (ex.: DATABASE_URL). Se o valor era real, considere-o vazado e rotacione-o.`,
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
      })}\n`,
    );
  }
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(
    `[guard-prompt] erro interno: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
