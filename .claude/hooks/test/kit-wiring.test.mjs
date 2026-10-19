// @ts-check
/**
 * Ligações entre skills, agentes, MCP e hooks do kit: o que um portão (pre-pr, verify,
 * new-feature) manda usar precisa existir e estar disponível em qualquer sessão, o agente de
 * QA precisa enxergar o MCP que as instruções dele mandam usar, e toda ferramenta que executa
 * comando de shell passa pelo guard-bash.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT, runHook } from '../test-support/helpers.mjs';

const CLAUDE_DIR = path.join(PROJECT_ROOT, '.claude');

/**
 * Frontmatter como mapa chave -> texto bruto (inclui continuações indentadas).
 * @param {string} file
 * @returns {Map<string, string>}
 */
function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(fm, `sem frontmatter: ${file}`);
  /** @type {Map<string, string>} */
  const out = new Map();
  let current = '';
  for (const line of (fm[1] ?? '').split('\n')) {
    const key = /^([\w-]+):(.*)$/.exec(line);
    if (key) {
      current = key[1] ?? '';
      out.set(current, (key[2] ?? '').trim());
    } else if (current) {
      out.set(current, `${out.get(current) ?? ''}\n${line}`.trim());
    }
  }
  return out;
}

/** @param {string} name */
const skillFile = (name) => path.join(CLAUDE_DIR, 'skills', name, 'SKILL.md');
/** @param {string} name */
const agentFile = (name) => path.join(CLAUDE_DIR, 'agents', `${name}.md`);

/**
 * @param {string} text
 * @param {RegExp} re
 */
function cited(text, re) {
  return [...new Set([...text.matchAll(re)].map((m) => m[1] ?? ''))];
}

describe('portões do fluxo (pre-pr, verify, new-feature)', () => {
  for (const gate of ['pre-pr', 'verify', 'new-feature']) {
    const text = readFileSync(skillFile(gate), 'utf8');

    for (const name of cited(text, /[Ss]kill `([\w-]+)`/g)) {
      it(`${gate} -> skill ${name}: existe e não depende de \`paths\``, () => {
        assert.ok(existsSync(skillFile(name)), `skill ${name} não existe`);
        // Skill com `paths` só é oferecida depois que a sessão toca um arquivo do padrão; um
        // portão rodado numa sessão nova não conseguiria invocá-la.
        assert.equal(frontmatter(skillFile(name)).has('paths'), false);
      });
    }

    for (const name of cited(text, /(?:[Ss]ubagente|agente) `([\w-]+)`/g)) {
      it(`${gate} -> agente ${name}: existe`, () => {
        assert.ok(existsSync(agentFile(name)), `agente ${name} não existe`);
      });
    }
  }

  it('review-migration delega ao agente migration-reviewer e o pre-pr cita o fallback', () => {
    assert.equal(frontmatter(skillFile('review-migration')).get('agent'), 'migration-reviewer');
    assert.match(readFileSync(skillFile('pre-pr'), 'utf8'), /`migration-reviewer`/);
  });
});

describe('plugins habilitados não duplicam material vendorizado', () => {
  // Plugin de origem -> prefixo dos arquivos vendorizados dele (scripts/vendor-claude-skills.sh).
  const VENDORED_PLUGINS = new Map([
    ['pr-review-toolkit', 'anthropic-'],
    ['fp-check', 'tob-'],
    ['differential-review', 'tob-'],
    ['sharp-edges', 'tob-'],
    ['property-based-testing', 'tob-'],
    ['superpowers', 'superpowers-'],
    ['sentry-skills', 'sentry-'],
    ['playwright-cli', 'ms-'],
    // O plugin `playwright` do marketplace oficial sobe outro servidor MCP via npx.
    ['playwright', 'mcp:'],
  ]);
  const settings = JSON.parse(readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
  const enabled = Object.entries(settings.enabledPlugins ?? {})
    .filter(([, on]) => on === true)
    .map(([id]) => id.split('@')[0] ?? id);

  for (const [plugin, prefix] of VENDORED_PLUGINS) {
    it(`${plugin} não está habilitado (já existe como ${prefix}*)`, () => {
      assert.equal(enabled.includes(plugin), false);
    });
  }
});

describe('guard-bash cobre toda ferramenta que executa comando de shell', () => {
  const settings = JSON.parse(readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
  /** @type {Array<{ matcher?: string, hooks?: Array<{ args?: string[], onFailure?: string }> }>} */
  const preToolUse = settings.hooks?.PreToolUse ?? [];

  /**
   * Casa um matcher de hook como o Claude Code: vazio ou `*` casa tudo; só letras, dígitos,
   * `_` e `|` é lista de nomes exatos; outro caractere vira expressão regular (ancorada aqui,
   * para o teste não passar por casamento parcial).
   * @param {string | undefined} matcher
   * @param {string} tool
   */
  function matcherMatches(matcher, tool) {
    if (matcher === undefined || matcher === '' || matcher === '*') return true;
    if (/^[\w|]+$/.test(matcher)) return matcher.split('|').includes(tool);
    return new RegExp(`^(?:${matcher})$`).test(tool);
  }

  /** @param {string} tool */
  function guardBashFor(tool) {
    return preToolUse
      .filter((entry) => matcherMatches(entry.matcher, tool))
      .flatMap((entry) => entry.hooks ?? [])
      .filter((hook) => (hook.args ?? []).some((arg) => arg.endsWith('/guard-bash.mjs')));
  }

  // Monitor recebe `command` (script de shell, no mesmo ambiente do Bash) ou `ws` (WebSocket,
  // sem shell). Sem o matcher, `Monitor({ command: 'cat .env' })` não passaria por guarda nenhum.
  for (const tool of ['Bash', 'Monitor']) {
    it(`${tool}: PreToolUse registra o guard-bash com onFailure block`, () => {
      const hooks = guardBashFor(tool);
      assert.ok(hooks.length > 0, `guard-bash não roda para ${tool}`);
      for (const hook of hooks) assert.equal(hook.onFailure, 'block');
    });
  }

  /** @param {Record<string, unknown>} toolInput */
  function monitorDecision(toolInput) {
    const r = runHook('guard-bash.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Monitor',
      tool_input: { description: 'sonda', timeout_ms: 300_000, ...toolInput },
      cwd: PROJECT_ROOT,
    });
    assert.equal(r.status, 0, r.stderr);
    return {
      decision: r.json?.hookSpecificOutput?.permissionDecision ?? 'none',
      reason: String(r.json?.hookSpecificOutput?.permissionDecisionReason ?? ''),
    };
  }

  it('nega `cat .env` vindo do Monitor', () => {
    const r = monitorDecision({ command: 'cat .env' });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /^\[guard-bash\] /);
  });

  it('nega segredo lido dentro do laço de um monitor', () => {
    const r = monitorDecision({ command: 'while true; do cat apps/web/.env.local; sleep 1; done' });
    assert.equal(r.decision, 'deny');
  });

  it('não emite nada para um monitor comum', () => {
    const r = monitorDecision({ command: 'tail -f apps/web/dev.log | grep --line-buffered ERROR' });
    assert.equal(r.decision, 'none');
  });

  it('Monitor com fonte ws (sem command) passa sem decisão', () => {
    const r = monitorDecision({ ws: { url: 'wss://events.example.invalid/stream' } });
    assert.equal(r.decision, 'none');
  });
});

describe('agente qa-engineer e o MCP do Playwright', () => {
  const tools = (frontmatter(agentFile('qa-engineer')).get('tools') ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  const mcp = JSON.parse(readFileSync(path.join(PROJECT_ROOT, '.mcp.json'), 'utf8'));

  it('o servidor citado nas instruções existe no .mcp.json', () => {
    assert.ok(mcp.mcpServers?.playwright, 'servidor playwright ausente do .mcp.json');
  });

  it('enxerga as ferramentas de exploração do MCP', () => {
    for (const tool of [
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_snapshot',
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_type',
      'mcp__playwright__browser_console_messages',
    ]) {
      assert.ok(tools.includes(tool), `${tool} fora de tools`);
    }
  });

  it('não recebe a execução de código no processo do servidor MCP', () => {
    assert.equal(tools.includes('mcp__playwright'), false, 'servidor inteiro liberado');
    assert.equal(tools.includes('mcp__playwright__browser_run_code_unsafe'), false);
  });
});
