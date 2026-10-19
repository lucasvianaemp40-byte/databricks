# ADR-0011: Plugins e MCP do Playwright nas sessões na nuvem

- **Status:** Aceito. Substitui a decisão 3 e o fato sobre plugins na nuvem do
  [ADR-0008](0008-desenvolvimento-assistido-por-ia.md).
- **Data:** 2026-10-17
- **Relacionados:** [ADR-0008](0008-desenvolvimento-assistido-por-ia.md),
  [.claude/README.md](../../.claude/README.md),
  [fluxo com o Claude](../desenvolvimento/fluxo-com-claude.md)

## Contexto

O ADR-0008 afirmou que, numa sessão na nuvem (claude.ai/code), os plugins declarados no
`.claude/settings.json` do repositório não carregam, e decidiu "plugins só para quem usa o CLI
local". A base foi um teste na sessão de pesquisa (Claude Code 2.1.302), cujo debug log
registrou `Skipping orphaned enabledPlugins entry …: marketplace not registered`.

Fatos verificados em 2026-10-17, numa sessão na nuvem deste repositório depois de reiniciada:

- Os plugins do marketplace `claude-plugins-official` habilitados em `enabledPlugins`
  **carregaram**. `claude-security`, `pr-review-toolkit` e `claude-md-management` apareceram
  como agentes e skills, e o cache ficou em `~/.claude/plugins/cache/claude-plugins-official`.
- Os da `trailofbits` **não carregaram**. Esse marketplace não constava em
  `~/.claude/plugins/known_marketplaces.json`; o oficial constava.
- **Não verificado:** se o mesmo acontece numa sessão nova, sem cache. A primeira sessão de um
  ambiente pode começar sem plugins.

Conferido de novo em 2026-10-18, numa sessão na nuvem deste repositório já com cache: as
skills de `claude-security` e `claude-md-management` estavam disponíveis, nenhuma da
`trailofbits`, e
`known_marketplaces.json` continuava só com o oficial. A skill `pr-review-toolkit:review-pr`
também estava disponível, embora o plugin já tivesse saído de `enabledPlugins` (decisão 3): ele
continua em `~/.claude/plugins/cache/claude-plugins-official`, e não foi verificado de onde a
sessão o carregou.

Conclusão: o que decide é o marketplace estar registrado no container, e não o fato de o
plugin ser declarado no repositório. O `extraKnownMarketplaces` do `.claude/settings.json` não
garantiu esse registro na nuvem. "Plugins de projeto não carregam na nuvem" generalizava um
caso.

Consequências práticas que o fato antigo escondia:

- `pr-review-toolkit` estava habilitado **e** vendorizado (três agentes `anthropic-*`). Com o
  plugin carregando, os agentes apareciam em dobro.
- `security-guidance` também roda na nuvem e revisa o diff com um modelo no fim do turno e em
  commit/push. Cada revisão tem custo além da sessão.
- O MCP do Playwright rodava por `npx @playwright/mcp@0.0.83`: na nuvem dependia de download
  pelo proxy e trazia uma segunda cópia do Playwright, fora do lockfile e da quarentena.

## Decisão

1. **Plugins são complemento em qualquer ambiente, nunca a defesa.** Ficam habilitados em
   `enabledPlugins`: `security-guidance`, `claude-security`, `typescript-lsp` e
   `claude-md-management` (`claude-plugins-official`); `insecure-defaults`, `static-analysis`,
   `supply-chain-risk-auditor` e `variant-analysis` (`trailofbits`). Cada um carrega ou não
   conforme o marketplace esteja registrado no ambiente.
2. **O essencial continua vendorizado em `.claude/`** (decisões 1 e 2 do ADR-0008). A incerteza
   justifica isso: os da `trailofbits` não carregaram na nuvem e a sessão nova sem cache não
   foi verificada.
3. **Material vendorizado não é habilitado também como plugin.** `pr-review-toolkit` sai de
   `enabledPlugins`. Ficam de fora `code-reviewer`, `code-simplifier`, `comment-analyzer` e
   `/review-pr`; a revisão de PR do projeto é a skill `pre-pr`. O teste
   `.claude/hooks/test/kit-wiring.test.mjs` falha se um plugin habilitado duplicar material
   vendorizado.
4. **MCP do Playwright pelo Playwright do lockfile.** O `.mcp.json` roda
   `bash .claude/mcp/playwright-mcp.sh`, que executa
   `pnpm --filter @salon/web exec playwright mcp` (Playwright 1.64 do `pnpm-lock.yaml`), sem
   `npx` e sem download:
   - headless, perfil isolado (`--isolated`), service workers bloqueados, saída em
     `test-results/playwright-mcp`;
   - origens limitadas a `localhost:3000`, `127.0.0.1:3000` e `127.0.0.1:3100`
     (`--allowed-origins` não é fronteira de segurança);
   - sem o Chromium da versão, usa a maior revisão `chromium-*` em `PLAYWRIGHT_BROWSERS_PATH`
     (padrão `/opt/pw-browsers`) e avisa no stderr; `PLAYWRIGHT_MCP_EXECUTABLE_PATH` força um
     executável;
   - alterar o wrapper ou o `.mcp.json` pede confirmação (regras `ask` e `guard-files`). Na
     nuvem, a regra `ask` nativa não pede, porque ali edição de arquivo roda sem perguntar, e
     não foi verificado se o `ask` do `guard-files` pede
     ([fluxo com o Claude, seção 1](../desenvolvimento/fluxo-com-claude.md#1-o-que-carrega-em-cada-ambiente)).
5. **Ferramentas de navegador com escopo.** O agente `qa-engineer` recebe as ferramentas de
   navegação, inspeção e interação do MCP (`mcp__playwright__browser_*`), sem
   `browser_run_code_unsafe` (código no processo do servidor) e sem `browser_file_upload` (lê
   arquivo local). A skill `ms-playwright-cli` não pré-aprova nenhum comando: o `guard-bash`
   pede confirmação para `run-code`, `eval`, `state-*`, cookies e storage, `route`, `upload`,
   `--filename` e `--config`, e nega `attach`, `--profile` e `--persistent`.
6. **Custo do `security-guidance` é decisão do time.** O plugin continua habilitado. O custo
   estimado de cada revisão fica em `~/.claude/security/log.txt` (campo `est_cost_usd`). Para
   gastar menos: `SECURITY_REVIEW_MODEL` (revisão do diff) e `SG_AGENTIC_MODEL` (commit/push)
   com um modelo mais barato. Para desligar camadas: `ENABLE_STOP_REVIEW=0` ou
   `ENABLE_COMMIT_REVIEW=0` (fonte: README e `hooks/security_reminder_hook.py` do plugin
   2.0.14).

## Consequências

- **Positivas:**
  - a documentação descreve o que de fato carrega, com o que não foi verificado dito
    explicitamente;
  - o `enabledPlugins` do projeto não põe nenhum agente em dobro (um plugin que a sessão
    ainda carregue de outra origem, como o `pr-review-toolkit` em 2026-10-18, pode duplicar);
  - o MCP funciona na nuvem sem download e usa o mesmo Playwright do E2E, sob a mesma
    quarentena e o mesmo Renovate.
- **Negativas e riscos:**
  - o conjunto de plugins varia por ambiente: duas sessões podem ter ferramentas diferentes.
    Nenhuma regra do projeto pode depender de plugin;
  - o `security-guidance` gasta também na nuvem;
  - sem `pr-review-toolkit`, perdem-se os outros revisores dele.
- **Ações decorrentes:**
  - verificar o carregamento numa sessão nova, sem cache, e registrar o resultado aqui e no
    [.claude/README.md](../../.claude/README.md#plugins);
  - avaliar registrar o marketplace `trailofbits` no setup script do ambiente da nuvem (não
    verificado);
  - ao vendorizar material de um plugin, tirá-lo de `enabledPlugins` no mesmo PR.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Manter "plugins só para o CLI local" | Contradiz o observado: os do marketplace oficial carregam na nuvem |
| Depender dos plugins na nuvem e parar de vendorizar | O carregamento não é garantido (`trailofbits` não carregou; sessão nova sem cache não verificada) |
| Manter `pr-review-toolkit` habilitado junto com os agentes vendorizados | Agentes em dobro na lista, com versões possivelmente diferentes |
| Manter `npx @playwright/mcp` em versão fixa | Download em tempo de execução na nuvem e uma segunda cópia do Playwright fora do lockfile e da quarentena |

## Referências

- Claude Code, plugins, marketplaces e ambientes na nuvem: https://code.claude.com/docs/en/
- Verificação na sessão: `~/.claude/plugins/known_marketplaces.json` e
  `~/.claude/plugins/cache/` (não versionados).
- Implementação: [`.mcp.json`](../../.mcp.json),
  [`.claude/mcp/playwright-mcp.sh`](../../.claude/mcp/playwright-mcp.sh),
  [`.claude/README.md`](../../.claude/README.md#mcp).
