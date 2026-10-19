// @ts-check
/**
 * Contrato dos scripts da raiz (CLAUDE.md, "Comandos"): o gate local `pnpm verify` roda, nesta
 * ordem, format:check, lint, knip, typecheck, test e build. Se alguém tirar um passo (o knip,
 * por exemplo) ou mudar a ordem, o `pnpm test:root` reprova.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// `pnpm test:root` roda na raiz do repositório; caminho literal (regra security do ESLint).
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('package.json da raiz', () => {
  it('verify roda format:check, lint, knip, typecheck, test e build, nessa ordem', () => {
    const steps = String(pkg.scripts.verify)
      .split('&&')
      .map((s) => s.trim());
    assert.deepEqual(steps, [
      'pnpm format:check',
      'pnpm lint',
      'pnpm knip',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
    ]);
  });

  it('test inclui as suítes da raiz (test:root)', () => {
    assert.match(String(pkg.scripts.test), /&& pnpm test:root$/);
  });

  it('lint cobre o reporter compartilhado em test-support/', () => {
    assert.match(String(pkg.scripts.lint), /"test-support\/\*\.ts"/);
    assert.match(String(pkg.scripts['lint:fix']), /"test-support\/\*\.ts"/);
  });
});
