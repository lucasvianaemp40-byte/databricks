#!/usr/bin/env bash
# Vendoriza skills e agentes de terceiros em .claude/ a partir de commits FIXOS e gera
# THIRD_PARTY_NOTICES.md.
#
# Segurança (o conteúdo de terceiros é tratado como dado não confiável):
#   - só `git fetch` do SHA fixado num repositório bare temporário e leitura de blobs com
#     `git cat-file`: nenhum checkout, hook, filtro, submódulo ou script dos repositórios roda;
#   - allowlist explícita, arquivo a arquivo (MANIFEST abaixo); só arquivos comuns (modo
#     100644) são aceitos: links simbólicos e executáveis são recusados;
#   - `allowed-tools` amplos (Bash sem escopo, Write, Edit, WebFetch, Task) são reduzidos a
#     leitura, porque `allowed-tools` pré-aprova ferramentas sem passar pelo trust do workspace;
#     agentes sem `tools` recebem uma lista mínima;
#   - nomes recebem prefixo da origem (tob-, sentry-, anthropic-, superpowers-, ms-) para não
#     colidir com skills próprias nem substituir comandos embutidos (ex.: /security-review);
#   - a saída é conferida: sem caracteres invisíveis/bidi, sem `!` + crase (execução de shell
#     em SKILL.md), sem referências a nomes antigos.
#
# Cada arquivo da allowlist foi lido integralmente na revisão de 2026-10-17. Ao trocar um SHA
# ou incluir arquivo, leia de novo TODO arquivo novo ou alterado (instruções escondidas,
# comandos perigosos, exfiltração, ferramentas amplas) antes de commitar.
#
# Uso (na raiz do repositório): bash scripts/vendor-claude-skills.sh
# Depois: git status .claude THIRD_PARTY_NOTICES.md && git diff
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export VENDOR_ROOT="$ROOT" VENDOR_WORK="$WORK"
export TOB_REPO=trailofbits/skills
export TOB_SHA=5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0
export SENTRY_REPO=getsentry/skills
export SENTRY_SHA=f57ada2d0b640406ea7e25b11d636c530e77c58b
export ANTHROPIC_REPO=anthropics/claude-plugins-official
export ANTHROPIC_SHA=ea10b213686c90bb1984b2016937310e05336cf3
export SUPERPOWERS_REPO=obra/superpowers
export SUPERPOWERS_SHA=bb92a77741419a4ab5f06e711a283343f1ada0c3
export MS_REPO=microsoft/playwright-cli
export MS_SHA=b85c7a736bb473bf55b584e54a09ffa698d6d871

# fetch <slug> <owner/repo> <sha>: repositório bare, só o commit fixado.
fetch() {
  local dir="$WORK/$1"
  git init -q --bare "$dir"
  git -C "$dir" -c protocol.version=2 fetch -q --depth 1 --no-tags --no-recurse-submodules \
    "https://github.com/$2.git" "$3"
  if [ "$(git -C "$dir" rev-parse --verify --quiet "$3^{commit}")" != "$3" ]; then
    echo "SHA inesperado em $2" >&2
    exit 1
  fi
}

fetch tob "$TOB_REPO" "$TOB_SHA"
fetch sentry "$SENTRY_REPO" "$SENTRY_SHA"
fetch anthropic "$ANTHROPIC_REPO" "$ANTHROPIC_SHA"
fetch superpowers "$SUPERPOWERS_REPO" "$SUPERPOWERS_SHA"
fetch ms "$MS_REPO" "$MS_SHA"

node - <<'JS'
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.VENDOR_ROOT;
const WORK = process.env.VENDOR_WORK;
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`variável ausente: ${name}`);
  return value;
};

const SOURCES = {
  tob: {
    repo: env('TOB_REPO'),
    sha: env('TOB_SHA'),
    author: 'Trail of Bits',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    licenseFile: '.claude/licenses/trailofbits-skills-CC-BY-SA-4.0.txt',
    licenseFrom: 'LICENSE',
  },
  sentry: {
    repo: env('SENTRY_REPO'),
    sha: env('SENTRY_SHA'),
    author: 'Functional Software, Inc. (Sentry)',
    license: 'Apache-2.0 (referências derivadas do OWASP Cheat Sheet Series: CC BY-SA 4.0)',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    licenseFile: '.claude/licenses/getsentry-skills-Apache-2.0.txt',
    licenseFrom: 'LICENSE',
    extraLicenses: [
      {
        from: 'skills/security-review/LICENSE',
        to: '.claude/licenses/getsentry-security-review-OWASP-CC-BY-SA-4.0.txt',
      },
    ],
  },
  anthropic: {
    repo: env('ANTHROPIC_REPO'),
    sha: env('ANTHROPIC_SHA'),
    author: 'Anthropic, PBC (plugin pr-review-toolkit)',
    license: 'Apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    licenseFile: '.claude/licenses/anthropic-pr-review-toolkit-Apache-2.0.txt',
    licenseFrom: 'plugins/pr-review-toolkit/LICENSE',
  },
  superpowers: {
    repo: env('SUPERPOWERS_REPO'),
    sha: env('SUPERPOWERS_SHA'),
    author: 'Jesse Vincent (Copyright (c) 2025 Jesse Vincent)',
    license: 'MIT',
    licenseUrl: 'https://opensource.org/license/mit',
    licenseFile: '.claude/licenses/obra-superpowers-MIT.txt',
    licenseFrom: 'LICENSE',
  },
  ms: {
    repo: env('MS_REPO'),
    sha: env('MS_SHA'),
    author: 'Microsoft Corporation',
    license: 'Apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    licenseFile: '.claude/licenses/microsoft-playwright-cli-Apache-2.0.txt',
    licenseFrom: 'LICENSE',
  },
};

const READ_ONLY_GIT =
  'Read Grep Glob Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git blame *)';
const PW = 'pnpm --filter @salon/web exec playwright';

// Cada entrada: origem, destino e as adaptações locais (todas listadas no NOTICE).
//   name / description / allowedTools / addTools: frontmatter
//   replace: [de, para] obrigatórios (falha se o trecho sumir num SHA novo)
//   replaceAll: [de, para] aplicados onde houver
//   between: [início, fim, novo] troca o trecho [início, fim)
//   section: [título, corpo] troca a seção até o próximo "## " (ou o fim)
//   fenced: [de, para] só dentro de blocos de código
//   note: observação em pt-BR inserida após a linha de procedência (SKILL.md e agentes)
const MANIFEST = [
  // --- Trail of Bits: fp-check -------------------------------------------------------------
  {
    src: 'tob',
    from: 'plugins/fp-check/skills/fp-check/SKILL.md',
    to: '.claude/skills/tob-fp-check/SKILL.md',
    name: 'tob-fp-check',
    allowedTools: `${READ_ONLY_GIT} LSP AskUserQuestion TaskCreate TaskUpdate TaskList TaskGet`,
    replaceAll: [['{baseDir}', '${CLAUDE_SKILL_DIR}']],
    note: 'Neste repositório os agentes são `tob-data-flow-analyzer`, `tob-exploitability-verifier` e `tob-poc-builder`. PoC executável vira teste `*.poc.*` que falha (ver o agente `tenant-isolation-pentester`).',
    changes: 'nome com prefixo; allowed-tools sem Bash/Write/Edit/Task amplos; {baseDir} -> ${CLAUDE_SKILL_DIR}; nota local',
  },
  ...[
    'bug-class-verification',
    'evidence-templates',
    'false-positive-patterns',
    'gate-reviews',
    'standard-verification',
  ].map((r) => ({
    src: 'tob',
    from: `plugins/fp-check/skills/fp-check/references/${r}.md`,
    to: `.claude/skills/tob-fp-check/references/${r}.md`,
    replaceAll: [['({baseDir}/references/', '(']],
    changes: 'links relativos no lugar de {baseDir}',
  })),
  {
    src: 'tob',
    from: 'plugins/fp-check/skills/fp-check/references/deep-verification.md',
    to: '.claude/skills/tob-fp-check/references/deep-verification.md',
    replace: [
      ["using the plugin's agents", 'using the agents listed below'],
      ['| `data-flow-analyzer` |', '| `tob-data-flow-analyzer` |'],
      ['| `exploitability-verifier` |', '| `tob-exploitability-verifier` |'],
      ['| `poc-builder` |', '| `tob-poc-builder` |'],
    ],
    replaceAll: [['({baseDir}/references/', '(']],
    changes: 'links relativos; nomes dos agentes com prefixo tob-',
  },
  ...['data-flow-analyzer', 'exploitability-verifier', 'poc-builder'].map((a) => ({
    src: 'tob',
    from: `plugins/fp-check/agents/${a}.md`,
    to: `.claude/agents/tob-${a}.md`,
    name: `tob-${a}`,
    replaceAll: [
      ['Spawned by fp-check', 'Spawned by tob-fp-check'],
      ['the fp-check skill', 'the tob-fp-check skill'],
    ],
    note:
      a === 'poc-builder'
        ? 'Neste repositório: PoC executável é um teste `*.poc.*` (Vitest em packages/*, Playwright em apps/web/e2e). Nunca altere código de produção, migração ou configuração, nem desligue verificações para provar o achado.'
        : undefined,
    changes: 'nome com prefixo tob-; referências à skill tob-fp-check',
  })),

  // --- Trail of Bits: differential-review --------------------------------------------------
  {
    src: 'tob',
    from: 'plugins/differential-review/skills/differential-review/SKILL.md',
    to: '.claude/skills/tob-differential-review/SKILL.md',
    name: 'tob-differential-review',
    allowedTools: `${READ_ONLY_GIT} Bash(gh pr view *) Bash(gh pr diff *)`,
    replace: [
      [
        'passing that full namespaced name as `subagent_type` — a bare\n`adversarial-modeler` is unregistered and the dispatch fails at runtime.',
        'passing `tob-adversarial-modeler` as `subagent_type`.',
      ],
    ],
    replaceAll: [['differential-review:adversarial-modeler', 'tob-adversarial-modeler']],
    note: 'Neste repositório: grave o relatório em `docs/seguranca/auditorias/<AAAA-MM-DD>-diff-review-<branch>.md`. As skills `audit-context-building` e `issue-writer` citadas abaixo não existem aqui; leia a baseline com `git show <commit>:<arquivo>`, nunca com `git checkout`.',
    changes: 'nome com prefixo; allowed-tools sem Bash/Write amplos; agente tob-adversarial-modeler; nota local',
  },
  {
    src: 'tob',
    from: 'plugins/differential-review/skills/differential-review/methodology.md',
    to: '.claude/skills/tob-differential-review/methodology.md',
    replace: [
      [
        '# Checkout baseline commit\ngit checkout <baseline_commit>\n',
        '# Leia a baseline SEM trocar de commit (há trabalho local): git show <commit>:<arquivo>\ngit show <baseline_commit>:<path>\n',
      ],
      [
        'After baseline analysis, checkout back to head commit to analyze changes.',
        'The baseline was read with `git show`, so there is no checkout to undo.',
      ],
    ],
    changes: 'baseline lida com git show em vez de git checkout',
  },
  ...['adversarial', 'patterns'].map((r) => ({
    src: 'tob',
    from: `plugins/differential-review/skills/differential-review/${r}.md`,
    to: `.claude/skills/tob-differential-review/${r}.md`,
    changes: 'sem alterações',
  })),
  {
    src: 'tob',
    from: 'plugins/differential-review/skills/differential-review/reporting.md',
    to: '.claude/skills/tob-differential-review/reporting.md',
    section: [
      ['## File Naming and Location', 'Write the report to `docs/seguranca/auditorias/<YYYY-MM-DD>-diff-review-<branch>.md` inside this repository. Never write outside the repository (no Desktop, no home directory).'],
      ['## Integration with issue-writer', 'Not available in this repository.'],
      ['## Error Handling', 'If the file cannot be written, print the full report in the chat and tell the user. Do not write outside the repository.'],
    ],
    changes: 'local do relatório dentro do repositório; sem fallback para Desktop/home; sem issue-writer',
  },
  {
    src: 'tob',
    from: 'plugins/differential-review/agents/adversarial-modeler.md',
    to: '.claude/agents/tob-adversarial-modeler.md',
    name: 'tob-adversarial-modeler',
    replaceAll: [['{baseDir}/skills/differential-review/', '.claude/skills/tob-differential-review/']],
    changes: 'nome com prefixo; caminhos das referências',
  },

  // --- Trail of Bits: property-based-testing -----------------------------------------------
  {
    src: 'tob',
    from: 'plugins/property-based-testing/skills/property-based-testing/SKILL.md',
    to: '.claude/skills/tob-property-based-testing/SKILL.md',
    name: 'tob-property-based-testing',
    note: 'Neste repositório a biblioteca é fast-check com `@fast-check/vitest`; os arbitrários do domínio ficam em `packages/scheduling-core/test/arbitraries/`.',
    changes: 'nome com prefixo; nota local',
  },
  ...['generating', 'interpreting-failures', 'libraries', 'refactoring', 'reviewing'].map((r) => ({
    src: 'tob',
    from: `plugins/property-based-testing/skills/property-based-testing/references/${r}.md`,
    to: `.claude/skills/tob-property-based-testing/references/${r}.md`,
    changes: 'sem alterações',
  })),

  // --- Trail of Bits: sharp-edges ----------------------------------------------------------
  {
    src: 'tob',
    from: 'plugins/sharp-edges/skills/sharp-edges/SKILL.md',
    to: '.claude/skills/tob-sharp-edges/SKILL.md',
    name: 'tob-sharp-edges',
    replace: [
      [
        '- **Real-World Case Studies**: See [references/case-studies.md](references/case-studies.md) (OpenSSL, GMP, etc.)\n',
        '',
      ],
    ],
    replaceAll: [['`sharp-edges-analyzer`', '`tob-sharp-edges-analyzer`']],
    between: [
      [
        '**By language** (general footguns, not crypto-specific):',
        '## Quality Checklist',
        '**By language**: this repository is TypeScript only, so only [references/lang-javascript.md](references/lang-javascript.md) was vendored.\n\n',
      ],
    ],
    changes: 'nome com prefixo; só a referência de JavaScript/TypeScript (as de outras linguagens e case-studies não foram vendorizadas)',
  },
  ...['auth-patterns', 'config-patterns', 'crypto-apis', 'lang-javascript'].map((r) => ({
    src: 'tob',
    from: `plugins/sharp-edges/skills/sharp-edges/references/${r}.md`,
    to: `.claude/skills/tob-sharp-edges/references/${r}.md`,
    changes: 'sem alterações',
  })),
  {
    src: 'tob',
    from: 'plugins/sharp-edges/agents/sharp-edges-analyzer.md',
    to: '.claude/agents/tob-sharp-edges-analyzer.md',
    name: 'tob-sharp-edges-analyzer',
    between: [
      [
        '## Language-Specific References',
        '## Rationalizations to Reject',
        '## References\n\nRead ON DEMAND (this repository is TypeScript only):\n\n- **Cryptographic APIs**: `.claude/skills/tob-sharp-edges/references/crypto-apis.md`\n- **Configuration Patterns**: `.claude/skills/tob-sharp-edges/references/config-patterns.md`\n- **Authentication/Session**: `.claude/skills/tob-sharp-edges/references/auth-patterns.md`\n- **JavaScript/TypeScript**: `.claude/skills/tob-sharp-edges/references/lang-javascript.md`\n\nDo not guess at language-specific behavior — verify it in the reference material.\n\n',
      ],
    ],
    changes: 'nome com prefixo; lista de referências reduzida às vendorizadas',
  },

  // --- Sentry: security-review -------------------------------------------------------------
  {
    src: 'sentry',
    from: 'skills/security-review/SKILL.md',
    to: '.claude/skills/sentry-security-review/SKILL.md',
    name: 'sentry-security-review',
    allowedTools: READ_ONLY_GIT,
    replace: [['license: LICENSE', 'license: Apache-2.0 (referências OWASP sob CC BY-SA 4.0); ver .claude/licenses/']],
    note: 'Neste repositório só existem as referências de `references/` (api-security, authentication, authorization, business-logic, csrf, data-protection, error-handling, injection, logging, misconfiguration, ssrf, xss) e `languages/javascript.md`; as demais citadas abaixo não foram vendorizadas. Regras do domínio (multi-tenant, RLS, LGPD): `.claude/claude-security-guidance.md` e o agente `appsec-reviewer`.',
    changes: 'renomeada (não substitui o /security-review embutido); allowed-tools sem Bash/Task amplos; campo license; nota local',
  },
  {
    src: 'sentry',
    from: 'skills/security-review/languages/javascript.md',
    to: '.claude/skills/sentry-security-review/languages/javascript.md',
    changes: 'sem alterações',
  },
  ...[
    'api-security',
    'authentication',
    'authorization',
    'business-logic',
    'csrf',
    'data-protection',
    'error-handling',
    'injection',
    'logging',
    'misconfiguration',
    'ssrf',
    'xss',
  ].map((r) => ({
    src: 'sentry',
    from: `skills/security-review/references/${r}.md`,
    to: `.claude/skills/sentry-security-review/references/${r}.md`,
    changes: 'sem alterações',
  })),

  // --- Anthropic: pr-review-toolkit --------------------------------------------------------
  {
    src: 'anthropic',
    from: 'plugins/pr-review-toolkit/agents/silent-failure-hunter.md',
    to: '.claude/agents/anthropic-silent-failure-hunter.md',
    name: 'anthropic-silent-failure-hunter',
    description:
      'Use this agent when reviewing code changes to identify silent failures, inadequate error handling and inappropriate fallback behavior (catch blocks, fallbacks, swallowed errors, error propagation). Invoke it proactively after completing work that involves error handling.',
    addTools: 'Read, Grep, Glob, Bash',
    replace: [
      ['- Is there an error ID from constants/errorIds.ts for Sentry tracking?\n', ''],
      ['- Use proper error IDs for Sentry tracking\n', ''],
    ],
    replaceAll: [['silent-failure-hunter agent', 'anthropic-silent-failure-hunter agent']],
    section: [
      [
        '## Special Considerations',
        'Patterns of this repository (Agenda Salão):\n- PostgreSQL errors are translated by `mapDatabaseError` (`@salon/db`) into typed errors (`SlotUnavailableError`, `TenantIsolationError`, ...). Never swallow them or turn them into success.\n- Security checks fail closed: an error while checking session, role or tenant denies access.\n- User-facing messages are in pt-BR, without stack traces, SQL, PostgreSQL `DETAIL` or personal data; details go to the server log, without PII.\n- Empty catch blocks are never acceptable. Tests are not fixed by disabling them.\n\nRemember: Every silent failure you catch prevents hours of debugging frustration for users and developers. Be thorough, be skeptical, and never let an error slip through unnoticed.',
      ],
    ],
    changes: 'nome com prefixo; description reescrita (o original não era YAML válido); tools mínimas; convenções internas do Claude Code (errorIds, Statsig) trocadas pelas do projeto',
  },
  {
    src: 'anthropic',
    from: 'plugins/pr-review-toolkit/agents/pr-test-analyzer.md',
    to: '.claude/agents/anthropic-pr-test-analyzer.md',
    name: 'anthropic-pr-test-analyzer',
    addTools: 'Read, Grep, Glob, Bash',
    changes: 'nome com prefixo; tools mínimas',
  },
  {
    src: 'anthropic',
    from: 'plugins/pr-review-toolkit/agents/type-design-analyzer.md',
    to: '.claude/agents/anthropic-type-design-analyzer.md',
    name: 'anthropic-type-design-analyzer',
    addTools: 'Read, Grep, Glob',
    changes: 'nome com prefixo; tools mínimas',
  },

  // --- obra/superpowers ---------------------------------------------------------------------
  {
    src: 'superpowers',
    from: 'skills/test-driven-development/SKILL.md',
    to: '.claude/skills/superpowers-test-driven-development/SKILL.md',
    name: 'superpowers-test-driven-development',
    note: 'Neste repositório: rode os testes com `pnpm --filter <pacote> test` ou `pnpm test` (nunca `npm`); a skill `verify` roda antes de cada commit e testes nunca são enfraquecidos.',
    changes: 'nome com prefixo; nota local',
  },
  {
    src: 'superpowers',
    from: 'skills/test-driven-development/writing-good-tests.md',
    to: '.claude/skills/superpowers-test-driven-development/writing-good-tests.md',
    replace: [['(superpowers:writing-skills)', '(the superpowers `writing-skills` skill, not vendored here)']],
    changes: 'referência a skill não vendorizada',
  },
  {
    src: 'superpowers',
    from: 'skills/systematic-debugging/SKILL.md',
    to: '.claude/skills/superpowers-systematic-debugging/SKILL.md',
    name: 'superpowers-systematic-debugging',
    replace: [
      ['`superpowers:test-driven-development`', '`superpowers-test-driven-development`'],
      ['`superpowers:verification-before-completion`', '`superpowers-verification-before-completion`'],
    ],
    changes: 'nome com prefixo; referências às skills vendorizadas',
  },
  {
    src: 'superpowers',
    from: 'skills/systematic-debugging/root-cause-tracing.md',
    to: '.claude/skills/superpowers-systematic-debugging/root-cause-tracing.md',
    between: [
      [
        'Use the bisection script `find-polluter.sh` in this directory:',
        '## Real Example: Empty projectDir',
        'Run the test files one at a time (e.g. `pnpm --filter <package> exec vitest run <file>`) and stop at the first one that leaves the artifact behind. (The upstream `find-polluter.sh` script was not vendored: this repository vendors no executable scripts.)\n\n',
      ],
    ],
    changes: 'script find-polluter.sh não vendorizado; instrução equivalente com vitest',
  },
  {
    src: 'superpowers',
    from: 'skills/systematic-debugging/defense-in-depth.md',
    to: '.claude/skills/superpowers-systematic-debugging/defense-in-depth.md',
    changes: 'sem alterações',
  },
  {
    src: 'superpowers',
    from: 'skills/systematic-debugging/condition-based-waiting.md',
    to: '.claude/skills/superpowers-systematic-debugging/condition-based-waiting.md',
    replace: [
      [
        'See `condition-based-waiting-example.ts` in this directory for complete implementation with domain-specific helpers (`waitForEvent`, `waitForEventCount`, `waitForEventMatch`) from actual debugging session.',
        '(The upstream `condition-based-waiting-example.ts` was not vendored.) In Playwright tests prefer web-first assertions (`await expect(locator).toBeVisible()`); in Vitest use `vi.waitFor`.',
      ],
    ],
    changes: 'exemplo .ts não vendorizado; equivalentes do Playwright/Vitest',
  },
  {
    src: 'superpowers',
    from: 'skills/verification-before-completion/SKILL.md',
    to: '.claude/skills/superpowers-verification-before-completion/SKILL.md',
    name: 'superpowers-verification-before-completion',
    note: 'Neste repositório a verificação padrão é a skill `verify` (`pnpm verify` e, conforme o caso, `pnpm test:db`, `pnpm test:hooks`, `pnpm e2e`).',
    changes: 'nome com prefixo; nota local',
  },

  // --- Microsoft: playwright-cli ------------------------------------------------------------
  {
    src: 'ms',
    from: 'skills/playwright-cli/SKILL.md',
    to: '.claude/skills/ms-playwright-cli/SKILL.md',
    name: 'ms-playwright-cli',
    allowedTools: `Bash(${PW} cli *)`,
    fenced: ['playwright-cli', `${PW} cli`],
    replace: [
      [
        'See [references/pr-attachments.md](references/pr-attachments.md) for alt text, inline references, size limits and attaching test artifacts from CI.\n',
        '',
      ],
    ],
    section: [
      [
        '## Installation',
        `In this repository the CLI comes from the app's Playwright, pinned by \`pnpm-lock.yaml\`: run \`${PW} cli <command>\`. Never install \`@playwright/cli\` globally and never use \`npx\` or \`npm install -g\` (dependency quarantine). Never \`attach --cdp\`, \`attach --extension\` or \`--profile\` pointing at a personal browser: only isolated sessions against http://localhost:3000 (dev) or http://127.0.0.1:3100 (production build used by E2E).`,
      ],
      [
        '## Specific tasks',
        '* **Running and Debugging Playwright tests** [references/playwright-tests.md](references/playwright-tests.md)\n* **Request mocking** [references/request-mocking.md](references/request-mocking.md)\n* **Storage state (cookies, localStorage)** [references/storage-state.md](references/storage-state.md)\n* **Test generation (plan / generate / heal)** [references/test-generation.md](references/test-generation.md)\n* **Inspecting element attributes** [references/element-attributes.md](references/element-attributes.md)\n\nOther upstream references (running code, sessions, tracing, video, PR attachments) were not vendored.',
      ],
    ],
    note: `Neste repositório o comando é \`${PW} cli\` (Playwright do app, travado no lockfile); specs E2E ficam em \`apps/web/e2e/\` e rodam com \`pnpm e2e\`. Arquivos de estado (state-save) com sessão nunca entram no git.`,
    changes: 'nome com prefixo; comando local em vez do binário global; seção de instalação substituída (sem npm -g/npx, sem attach ao navegador pessoal); allowed-tools restrito; referências não vendorizadas removidas',
  },
  ...['element-attributes', 'request-mocking', 'storage-state'].map((r) => ({
    src: 'ms',
    from: `skills/playwright-cli/references/${r}.md`,
    to: `.claude/skills/ms-playwright-cli/references/${r}.md`,
    fenced: ['playwright-cli', `${PW} cli`],
    changes: 'comando local nos blocos de código',
  })),
  {
    src: 'ms',
    from: 'skills/playwright-cli/references/playwright-tests.md',
    to: '.claude/skills/ms-playwright-cli/references/playwright-tests.md',
    fenced: ['playwright-cli', `${PW} cli`],
    replaceAll: [['npx playwright test', `${PW} test`]],
    changes: 'comando local (pnpm) no lugar de npx',
  },
  {
    src: 'ms',
    from: 'skills/playwright-cli/references/test-generation.md',
    to: '.claude/skills/ms-playwright-cli/references/test-generation.md',
    fenced: ['playwright-cli', `${PW} cli`],
    replace: [
      [
        'If there is no Playwright install, bootstrap one and let the user pick the defaults:\n\n```bash\nnpm init playwright@latest\n```',
        'Playwright is already installed in `apps/web` (specs in `apps/web/e2e/`). Never run `npm init playwright`.',
      ],
      ['| Managing the CLI browser session | [session-management.md](session-management.md) |\n', ''],
    ],
    replaceAll: [
      ['npx --no-install playwright --version', `${PW} --version`],
      ['npx playwright test', `${PW} test`],
    ],
    changes: 'comando local (pnpm); sem bootstrap via npm init; referência não vendorizada removida',
  },
];

// ---------------------------------------------------------------------------------------------

/** @param {string} slug @param {string} sha @param {string} from */
function readBlob(slug, sha, from) {
  const dir = path.join(WORK, slug);
  const entry = execFileSync('git', ['-C', dir, 'ls-tree', sha, '--', from], { encoding: 'utf8' });
  const [mode, type] = entry.split(/\s+/);
  if (mode !== '100644' || type !== 'blob') {
    throw new Error(`recusado (modo '${mode || 'ausente'}'): ${slug}:${from}`);
  }
  return execFileSync('git', ['-C', dir, 'cat-file', 'blob', `${sha}:${from}`], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** @param {string} rel @param {string} text */
function write(rel, text) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function mustReplace(text, from, to, where) {
  if (!text.includes(from)) throw new Error(`trecho não encontrado em ${where}: ${JSON.stringify(from.slice(0, 80))}`);
  return text.split(from).join(to);
}

function applyFrontmatter(text, item) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) throw new Error(`sem frontmatter: ${item.to}`);
  let head = fm[1];
  if (item.name) {
    if (!/^name: .*$/m.test(head)) throw new Error(`sem name: ${item.to}`);
    head = head.replace(/^name: .*$/m, `name: ${item.name}`);
  }
  if (item.description) {
    if (!/^description: .*$/m.test(head)) throw new Error(`sem description: ${item.to}`);
    head = head.replace(/^description: .*$/m, `description: ${JSON.stringify(item.description)}`);
  }
  if (item.allowedTools) {
    if (!/^allowed-tools:.*$/m.test(head)) throw new Error(`sem allowed-tools: ${item.to}`);
    head = head.replace(/^allowed-tools:.*$/m, `allowed-tools: ${item.allowedTools}`);
  }
  if (item.addTools) {
    if (/^tools:/m.test(head)) throw new Error(`tools já existe: ${item.to}`);
    head = `${head}\ntools: ${item.addTools}`;
  }
  return `---\n${head}\n---\n${text.slice(fm[0].length)}`;
}

function replaceSection(text, heading, body, where) {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`seção não encontrada em ${where}: ${heading}`);
  const next = text.indexOf('\n## ', start + heading.length + 2);
  const tail = next === -1 ? '' : text.slice(next);
  return `${text.slice(0, start + 1)}${heading}\n\n${body}\n${tail}`;
}

function replaceBetween(text, startMarker, endMarker, replacement, where) {
  const start = text.indexOf(startMarker);
  const end = start === -1 ? -1 : text.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) throw new Error(`marcadores não encontrados em ${where}: ${startMarker}`);
  return text.slice(0, start) + replacement + text.slice(end);
}

function applyFenced(text, from, to) {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line.split(`${from} `).join(`${to} `) : line;
    })
    .join('\n');
}

function provenance(src) {
  const s = SOURCES[src];
  const viral = s.license.startsWith('CC BY-SA') ? '; esta adaptação segue sob CC BY-SA 4.0' : '';
  return `Vendorizado de github.com/${s.repo} @ ${s.sha.slice(0, 12)} (${s.license}${viral}) por scripts/vendor-claude-skills.sh; alterações locais em THIRD_PARTY_NOTICES.md.`;
}

// Limpa apenas a saída anterior (nomes com prefixo de terceiros).
for (const dir of ['.claude/skills']) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir))) {
    if (/^(?:tob|sentry|superpowers|ms)-/.test(entry)) {
      fs.rmSync(path.join(ROOT, dir, entry), { recursive: true, force: true });
    }
  }
}
for (const entry of fs.readdirSync(path.join(ROOT, '.claude/agents'))) {
  if (/^(?:tob|anthropic)-.*\.md$/.test(entry)) fs.rmSync(path.join(ROOT, '.claude/agents', entry));
}
fs.rmSync(path.join(ROOT, '.claude/licenses'), { recursive: true, force: true });

for (const [slug, s] of Object.entries(SOURCES)) {
  write(s.licenseFile, readBlob(slug, s.sha, s.licenseFrom));
  for (const extra of s.extraLicenses ?? []) write(extra.to, readBlob(slug, s.sha, extra.from));
}

const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]|[\u{e0000}-\u{e007f}]/u;
for (const item of MANIFEST) {
  const s = SOURCES[item.src];
  let text = readBlob(item.src, s.sha, item.from);
  const isEntry = item.to.endsWith('/SKILL.md') || item.to.startsWith('.claude/agents/');
  if (isEntry) text = applyFrontmatter(text, item);
  for (const [from, to] of item.replace ?? []) text = mustReplace(text, from, to, item.to);
  for (const [from, to] of item.replaceAll ?? []) text = text.split(from).join(to);
  for (const [start, end, replacement] of item.between ?? []) {
    text = replaceBetween(text, start, end, replacement, item.to);
  }
  for (const [heading, body] of item.section ?? []) text = replaceSection(text, heading, body, item.to);
  if (item.fenced) text = applyFenced(text, item.fenced[0], item.fenced[1]);
  if (isEntry) {
    const fm = /^---\n[\s\S]*?\n---\n/.exec(text);
    const at = fm ? fm[0].length : 0;
    const note = item.note ? `>\n> ${item.note}\n` : '';
    text = `${text.slice(0, at)}\n> ${provenance(item.src)}\n${note}${text.slice(at)}`;
  }
  // Conferências de segurança da saída.
  if (INVISIBLE.test(text)) throw new Error(`caractere invisível/bidi em ${item.to}`);
  if (item.to.endsWith('/SKILL.md') && /!`/.test(text)) {
    throw new Error(`sintaxe de execução de shell (!\`) em ${item.to}`);
  }
  for (const stale of ['{baseDir}', 'superpowers:', 'differential-review:']) {
    if (text.includes(stale)) throw new Error(`referência antiga "${stale}" em ${item.to}`);
  }
  if (/^allowed-tools:.*(?:\bBash(?!\()|\bWrite\b|\bEdit\b|\bWebFetch\b)/m.test(text)) {
    throw new Error(`allowed-tools amplo em ${item.to}`);
  }
  write(item.to, text);
}

// THIRD_PARTY_NOTICES.md ---------------------------------------------------------------------
const lines = [
  '# Avisos de terceiros (THIRD_PARTY_NOTICES)',
  '',
  'Arquivos de terceiros incluídos em `.claude/` por `scripts/vendor-claude-skills.sh`. Cada',
  'arquivo foi obtido de um commit fixo, lido integralmente antes de entrar no repositório e',
  'adaptado como descrito abaixo. Cada SKILL.md e cada agente vendorizado traz, logo após o',
  'frontmatter, uma linha de procedência. Gerado automaticamente: não edite à mão; rode o script.',
  '',
  'O código da aplicação (apps/, packages/) não deriva destes materiais: as licenças abaixo',
  'valem só para os arquivos listados.',
  '',
];
for (const [slug, s] of Object.entries(SOURCES)) {
  const files = MANIFEST.filter((m) => m.src === slug);
  lines.push(`## ${s.author}`, '');
  lines.push(`- Origem: https://github.com/${s.repo} (commit \`${s.sha}\`)`);
  lines.push(`- Licença: ${s.license} (${s.licenseUrl}); cópia em \`${s.licenseFile}\`.`);
  for (const extra of s.extraLicenses ?? []) lines.push(`- Aviso adicional da origem: \`${extra.to}\`.`);
  if (s.license.startsWith('CC BY-SA')) {
    lines.push(
      '- Atribuição: material de Trail of Bits, sob CC BY-SA 4.0. Os arquivos adaptados abaixo',
      '  permanecem sob CC BY-SA 4.0 (compartilha-igual); as mudanças estão indicadas por arquivo.',
    );
  }
  if (s.license.startsWith('Apache')) {
    lines.push('- Arquivos modificados em relação à origem estão indicados abaixo (Apache-2.0, seção 4(b)).');
  }
  if (s.license === 'MIT') {
    lines.push('- Aviso de copyright e de permissão preservados na cópia da licença.');
  }
  lines.push('', '| Arquivo | Origem | Alterações |', '| --- | --- | --- |');
  for (const f of files) lines.push(`| \`${f.to}\` | \`${f.from}\` | ${f.changes ?? 'sem alterações'} |`);
  lines.push('');
}
lines.push(
  '## Não vendorizados (avaliados e recusados)',
  '',
  '- `claude-security` (claude-plugins-official): licença proprietária, proíbe redistribuição. Use como plugin local.',
  '- Skills de documentos do `anthropics/skills` (docx, pdf, pptx, xlsx): "source-available", todos os direitos reservados.',
  '- `trailofbits/claude-code-config`: repositório sem licença.',
  '- Semgrep Guardian (`semgrep/mcp-marketplace`): sem licença e com binários pré-compilados.',
  '- `getsentry/skills` skill-scanner: depende de um script Python não revisado para execução.',
  '- Demais referências da skill security-review da Sentry (cryptography, deserialization, file-security, modern-threats, supply-chain, python, docker), das referências de outras linguagens e `case-studies` do sharp-edges, e `agentic-actions-auditor`/`gha-security-review`: fora do escopo atual; disponíveis pelos plugins `trailofbits` e `sentry-skills` no CLI local.',
  '- Scripts e exemplos executáveis de qualquer origem (ex.: `find-polluter.sh`, `condition-based-waiting-example.ts`).',
  '',
);
write('THIRD_PARTY_NOTICES.md', `${lines.join('\n')}\n`);
console.log(`Vendorizados ${MANIFEST.length} arquivos de ${Object.keys(SOURCES).length} origens.`);
JS

echo "OK. Revise: git status .claude THIRD_PARTY_NOTICES.md && git diff"
