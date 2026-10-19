#!/usr/bin/env node
// @ts-check
/**
 * PreToolUse(Bash|Monitor): defesa em profundidade além de permissions.deny/ask.
 *
 * O Monitor manda `tool_input.command` (script de shell que roda no mesmo ambiente do Bash,
 * analisado aqui como um comando Bash) ou `tool_input.ws` (fonte WebSocket, sem shell), que
 * passa sem decisão porque não há comando a analisar.
 *
 * Bloqueia (deny): comandos destrutivos, force-push, push para main/master, --no-verify e
 * desligamento de hooks, leitura/despejo de segredos e do ambiente, execução de script
 * baixado da rede (curl | sh), escrita manual em lockfile e em migração já publicada,
 * alteração das configurações do próprio Claude Code por Bash.
 * Pede confirmação (ask): SQL destrutivo, reset/drop de banco, deploy/publicação,
 * dependência nova, rm recursivo fora de artefatos, descarte de trabalho local.
 *
 * Registrado com `"onFailure": "block"`; além disso, qualquer exceção vira `deny`
 * (fail-closed também em versões antigas do Claude Code). Regras em lib/bash-policy.mjs;
 * testes em test/guard-bash.test.mjs.
 */
import process from 'node:process';
import { createContext, evaluateBashCommand } from './lib/bash-policy.mjs';
import { runPreToolUseGuard } from './lib/hook-io.mjs';

runPreToolUseGuard('guard-bash', (input) => {
  const toolInput = input.tool_input ?? {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (command.trim() === '') return { decision: null, reasons: [] };
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : projectDir;
  return evaluateBashCommand(command, createContext({ cwd, projectDir }));
});
