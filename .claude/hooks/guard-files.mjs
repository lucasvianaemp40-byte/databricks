#!/usr/bin/env node
// @ts-check
/**
 * PreToolUse(Read|Edit|Write|MultiEdit|NotebookEdit|Grep): segredos, lockfiles e
 * migrações imutáveis. Complementa `permissions.deny` (que já cobre Read/Edit de
 * `.env*`) resolvendo links simbólicos e checando a branch padrão no git.
 *
 * Registrado com `"onFailure": "block"`; exceções viram `deny` (fail-closed).
 * Regras em lib/files-policy.mjs; testes em test/guard-files.test.mjs.
 */
import process from 'node:process';
import { createFilesContext, evaluateFileTool } from './lib/files-policy.mjs';
import { runPreToolUseGuard } from './lib/hook-io.mjs';

runPreToolUseGuard('guard-files', (input) => {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput =
    input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : projectDir;
  return evaluateFileTool(tool, toolInput, createFilesContext({ cwd, projectDir }));
});
