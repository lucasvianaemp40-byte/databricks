// @ts-check
/**
 * Wrapper do servidor MCP do Playwright (.claude/mcp/playwright-mcp.sh): usa o Playwright
 * do lockfile (sem npx) e escolhe um Chromium disponível quando o da versão não está baixado.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeBin, PROJECT_ROOT, tempDir } from '../test-support/helpers.mjs';

const SCRIPT = fileURLToPath(new URL('../../mcp/playwright-mcp.sh', import.meta.url));

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function printedArgs(env) {
  /** @type {NodeJS.ProcessEnv} */
  const base = { ...process.env, PLAYWRIGHT_MCP_PRINT_ARGS: '1' };
  delete base.PLAYWRIGHT_MCP_EXECUTABLE_PATH;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: base, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n');
}

/**
 * @param {string[]} args
 * @param {string} flag
 */
function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('wrapper do MCP do Playwright', () => {
  it('usa a maior revisão de Chromium disponível quando a da versão não existe', (t) => {
    const browsers = tempDir(t, 'pw-browsers');
    fakeBin(path.join(browsers, 'chromium-1194', 'chrome-linux', 'chrome'), 'exit 0');
    fakeBin(path.join(browsers, 'chromium-1200', 'chrome-linux64', 'chrome'), 'exit 0');
    fakeBin(
      path.join(browsers, 'chromium_headless_shell-1300', 'chrome-linux', 'chrome'),
      'exit 0',
    );
    const args = printedArgs({ PLAYWRIGHT_BROWSERS_PATH: browsers });
    assert.equal(
      flagValue(args, '--executable-path'),
      path.join(browsers, 'chromium-1200', 'chrome-linux64', 'chrome'),
    );
  });

  it('respeita PLAYWRIGHT_MCP_EXECUTABLE_PATH', (t) => {
    const browsers = tempDir(t, 'pw-browsers-env');
    fakeBin(path.join(browsers, 'chromium-1194', 'chrome-linux', 'chrome'), 'exit 0');
    const args = printedArgs({
      PLAYWRIGHT_BROWSERS_PATH: browsers,
      PLAYWRIGHT_MCP_EXECUTABLE_PATH: '/opt/chrome/chrome',
    });
    assert.equal(flagValue(args, '--executable-path'), '/opt/chrome/chrome');
  });

  it('sem navegador alternativo, deixa o Playwright usar o padrão dele', (t) => {
    const browsers = tempDir(t, 'pw-browsers-empty');
    const args = printedArgs({ PLAYWRIGHT_BROWSERS_PATH: browsers });
    assert.equal(args.includes('--executable-path'), false);
  });

  it('mantém o perfil isolado, as origens limitadas e a saída fora do git', (t) => {
    const args = printedArgs({ PLAYWRIGHT_BROWSERS_PATH: tempDir(t, 'pw-browsers-none') });
    for (const flag of ['--headless', '--isolated', '--block-service-workers']) {
      assert.ok(args.includes(flag), flag);
    }
    assert.equal(
      flagValue(args, '--allowed-origins'),
      'http://localhost:3000;http://127.0.0.1:3000;http://127.0.0.1:3100',
    );
    const output = flagValue(args, '--output-dir') ?? '';
    assert.ok(path.isAbsolute(output), output);
    assert.equal(path.relative(PROJECT_ROOT, output), path.join('test-results', 'playwright-mcp'));
  });

  it('.mcp.json chama o wrapper e não usa npx', () => {
    const config = JSON.parse(readFileSync(path.join(PROJECT_ROOT, '.mcp.json'), 'utf8'));
    const server = config.mcpServers?.playwright;
    assert.equal(server?.command, 'bash');
    assert.deepEqual(server?.args, ['.claude/mcp/playwright-mcp.sh']);
    assert.doesNotMatch(JSON.stringify(config), /\bnpx\b/);
  });
});
