# Ambiente do Claude Code (.claude/)

Configuração versionada do Claude Code para o Agenda Salão. Vale no CLI local, na IDE e nas
sessões na nuvem (claude.ai/code). Plugins de marketplace (`enabledPlugins`) só carregam no
CLI local; por isso o essencial está vendorizado aqui.

## Estrutura

| Caminho | Conteúdo |
| --- | --- |
| `settings.json` | permissões (deny/ask/allow), hooks, env (`TZ=UTC`, telemetria desligada), marketplaces e plugins do CLI local, MCP aprovado |
| `hooks/` | guardas e automações (Node, sem dependências); testes em `hooks/test/` |
| `agents/` | subagentes do projeto (pt-BR) e de terceiros (`tob-`, `anthropic-`) |
| `skills/` | skills do projeto (pt-BR) e de terceiros (`tob-`, `sentry-`, `superpowers-`, `ms-`) |
| `rules/` | regras curtas carregadas só ao tocar banco, domínio ou servidor web |
| `claude-security-guidance.md` | regras de segurança do domínio lidas pelo plugin `security-guidance` |
| `licenses/` | licenças dos materiais de terceiros (ver `THIRD_PARTY_NOTICES.md`) |

## Hooks

| Evento | Script | Comportamento |
| --- | --- | --- |
| PreToolUse `Bash` | `guard-bash.mjs` | nega comandos destrutivos, `sudo`, `curl \| sh`, force-push, push para main, `--no-verify`, leitura/despejo de segredos e do ambiente, escrita em lockfile, em migração publicada e na configuração do agente; pede confirmação para SQL destrutivo, migração/reset de banco, deploy, dependência nova. Fail-closed (`onFailure: block` e erro interno vira `deny`). |
| PreToolUse `Read\|Edit\|Write\|MultiEdit\|NotebookEdit\|Grep` | `guard-files.mjs` | nega `.env*` (exceto `.env.example`), chaves, certificados e diretórios de credenciais (inclusive via link simbólico); nega edição manual de lockfile e de migração que já está na branch padrão; pede confirmação para `_journal.json`. Fail-closed. |
| PostToolUse `Edit\|Write\|MultiEdit` | `post-edit-quality.mjs` | `biome check --write` e ESLint (`--fix --max-warnings=0`) só no arquivo editado; problema restante volta para o Claude (exit 2). |
| Stop | `stop-typecheck.mjs` | typecheck (turbo, com cache) só dos pacotes com arquivos alterados e seus dependentes; erro bloqueia o encerramento uma vez (`stop_hook_active`). |
| UserPromptSubmit | `guard-prompt.mjs` | bloqueia prompt com segredo colado (chave, token, URL de banco com senha) e suprime o texto. |
| SessionStart `startup\|resume` | `session-start.sh` | só na nuvem (`CLAUDE_CODE_REMOTE=true`): ativa o pnpm via corepack e roda `pnpm install --frozen-lockfile` quando o hash de lockfile/manifests muda. Nunca falha a sessão. |

Limites conhecidos:

- Os guardas analisam o comando, não o executam: são defesa em profundidade, não sandbox. Um
  script do repositório que lê `.env` por conta própria não é visto (por isso `.env` real
  nunca deve existir no container da nuvem; use os segredos do ambiente).
- A ferramenta PowerShell não é coberta (o projeto é Linux/macOS).
- A imutabilidade de migrações depende de existir a branch padrão local (`origin/HEAD`,
  `origin/main` ou `main`); o `session-start.sh` tenta `git remote set-head origin --auto`.
- Em sessão na nuvem com vários repositórios, hooks de `.claude/settings.json` não rodam: use
  o setup script do ambiente.

Testes: `pnpm test:hooks` (node:test) e `pnpm exec tsc -p .claude/hooks` (tipos via JSDoc).

## MCP

`.mcp.json` declara só o `playwright` (`@playwright/mcp@0.0.83`, versão fixa, sem segredos),
headless, perfil isolado, saída em `test-results/playwright-mcp` e origens limitadas a
`localhost:3000` (dev) e `127.0.0.1:3100` (build do E2E). Se o Chromium da versão do MCP não
estiver instalado, defina `PLAYWRIGHT_MCP_EXECUTABLE_PATH` com um Chromium local (no container
da nuvem: `/opt/pw-browsers/chromium-*/chrome-linux/chrome`). Alternativa sem download:
`pnpm --filter @salon/web exec playwright mcp` (Playwright 1.64 do app). Para automação por
linha de comando, a skill `ms-playwright-cli` usa `pnpm --filter @salon/web exec playwright cli`.

## Plugins (só CLI local)

`settings.json` registra os marketplaces `claude-plugins-official` e `trailofbits` e habilita:
`security-guidance` (revisão contínua com as regras de `claude-security-guidance.md`; custa
tokens a cada Stop: ajuste com `SECURITY_REVIEW_MODEL` ou `ENABLE_STOP_REVIEW=0`),
`claude-security` (scan sob demanda com SARIF; licença proprietária, não vendorizável),
`pr-review-toolkit`, `typescript-lsp` (requer `typescript-language-server` instalado),
`claude-md-management`, e da Trail of Bits `insecure-defaults`, `static-analysis`,
`supply-chain-risk-auditor` e `variant-analysis`. Os materiais que já estão vendorizados não
são habilitados como plugin, para não duplicar skills. Plugins só carregam depois que você
confia no workspace.

## Vendorização

`scripts/vendor-claude-skills.sh` baixa commits fixos (sem executar nada dos repositórios),
copia uma allowlist arquivo a arquivo, restringe `allowed-tools`, prefixa nomes e regenera
`THIRD_PARTY_NOTICES.md`. Para atualizar: troque o SHA, rode o script e LEIA o diff inteiro
antes de commitar.
