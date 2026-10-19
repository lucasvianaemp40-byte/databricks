// @ts-check
/**
 * `allowed-tools` no frontmatter de uma skill pré-aprova ferramentas sem passar pelo trust do
 * workspace. As skills de terceiros (vendorizadas por scripts/vendor-claude-skills.sh) só podem
 * pré-aprovar leitura; nenhuma skill pode pré-aprovar Bash com curinga para um comando que
 * executa código ou escreve (ex.: `Bash(... playwright cli *)` liberava run-code e eval).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../test-support/helpers.mjs';

const SKILLS_DIR = path.join(PROJECT_ROOT, '.claude', 'skills');
const VENDOR_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'vendor-claude-skills.sh');
const VENDORED = /^(?:tob|sentry|anthropic|superpowers|ms)-/;

/** Bash com curinga aceitável em qualquer skill: só comandos de leitura. */
const READ_ONLY_WILDCARDS = new Set([
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git blame *)',
  'Bash(git status *)',
  'Bash(gh pr view *)',
  'Bash(gh pr diff *)',
]);

/**
 * Itens de `allowed-tools` (linha única ou lista YAML indentada).
 * @param {string} text
 * @returns {string[] | null} null quando a skill não declara allowed-tools
 */
function allowedTools(text) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) return null;
  const lines = fm[1].split('\n');
  const start = lines.findIndex((line) => /^allowed-tools:/.test(line));
  if (start < 0) return null;
  let value = lines[start].slice('allowed-tools:'.length);
  for (let i = start + 1; i < lines.length && /^[ \t]+\S/.test(lines[i] ?? ''); i++) {
    value += `\n${lines[i]}`;
  }
  const listed = value.replace(/^[ \t]*-[ \t]+/gm, ' ').replace(/^\s*\[|\]\s*$/g, '');
  return listed.match(/[^\s,()]+(?:\([^()]*\))?/g) ?? [];
}

/** @returns {Set<string>} */
function scriptAllowlist() {
  const script = readFileSync(VENDOR_SCRIPT, 'utf8');
  const block = /const SAFE_ALLOWED_TOOLS = new Set\(\[([\s\S]*?)\]\);/.exec(script);
  assert.ok(block, 'SAFE_ALLOWED_TOOLS não encontrado no script de vendorização');
  return new Set([...(block[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ''));
}

const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('allowed-tools das skills', () => {
  it('o script de vendorização audita contra uma allowlist de leitura', () => {
    const allow = scriptAllowlist();
    assert.ok(allow.has('Read'));
    for (const item of allow) {
      if (item.startsWith('Bash')) assert.ok(READ_ONLY_WILDCARDS.has(item), item);
      assert.doesNotMatch(
        item,
        /^(?:(?:Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|Task|Agent)(?:\(|$)|mcp__)/,
      );
    }
  });

  for (const name of skills) {
    const text = readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    const tools = allowedTools(text);
    if (tools === null) continue;

    it(`${name}: Bash com curinga só para comandos de leitura`, () => {
      for (const tool of tools) {
        if (/^Bash\(.*\*/.test(tool)) assert.ok(READ_ONLY_WILDCARDS.has(tool), tool);
        assert.notEqual(tool, 'Bash', 'Bash sem escopo');
      }
    });

    if (VENDORED.test(name)) {
      it(`${name}: skill de terceiros só pré-aprova itens da allowlist do script`, () => {
        const allow = scriptAllowlist();
        for (const tool of tools) assert.ok(allow.has(tool), tool);
      });
    }
  }

  it('a auditoria do script recusa pré-aprovação ampla em qualquer formato', () => {
    const script = readFileSync(VENDOR_SCRIPT, 'utf8');
    const start = script.indexOf('function auditAllowedTools(');
    const end = script.indexOf('\n}\n', start);
    assert.ok(start >= 0 && end > start, 'auditAllowedTools não encontrada no script');
    // A função vive dentro do heredoc do script (não é importável). O trecho avaliado é o do
    // próprio script versionado neste repositório, não entrada externa.
    const audit = /** @type {(text: string, where: string) => void} */ (
      new Function(
        'SAFE_ALLOWED_TOOLS',
        `${script.slice(start, end + 2)}\nreturn auditAllowedTools;`,
      )(scriptAllowlist())
    );
    /** @param {string} head */
    const skill = (head) => `---\nname: x\n${head}\n---\n\ncorpo\n`;
    for (const head of [
      'allowed-tools: Bash(pnpm --filter @salon/web exec playwright cli *)',
      'allowed-tools: Read Bash',
      'allowed-tools: Read, Write',
      'allowed-tools: [Read, WebFetch]',
      'allowed-tools:\n  - Read\n  - Bash(node *)',
      'allowed-tools: Read mcp__playwright',
      'allowed-tools: Bash(git diff *) Bash(git push *)',
      'allowed-tools: Read Bash(git diff *))',
      '"allowed-tools": Bash',
      'allowed_tools: Bash',
    ]) {
      assert.throws(() => audit(skill(head), 'x'), /allowed-tools/, head);
    }
    for (const head of [
      'allowed-tools: Read Grep Glob',
      'allowed-tools: Read, Grep, Bash(git diff *)',
      'allowed-tools:\n  - Read\n  - Bash(git log *)',
      'description: lists the allowed tools',
    ]) {
      assert.doesNotThrow(() => audit(skill(head), 'x'), head);
    }
  });

  it('ms-playwright-cli não pré-aprova nenhum comando', () => {
    const text = readFileSync(path.join(SKILLS_DIR, 'ms-playwright-cli', 'SKILL.md'), 'utf8');
    assert.equal(allowedTools(text), null);
  });
});
