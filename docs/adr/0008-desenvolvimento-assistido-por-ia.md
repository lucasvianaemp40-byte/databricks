# ADR-0008: Desenvolvimento assistido por IA (kit Claude Code)

- **Status:** Aceito
- **Data:** 2026-10-17
- **Relacionados:** [fluxo com o Claude](../desenvolvimento/fluxo-com-claude.md),
  [.claude/README.md](../../.claude/README.md), [CLAUDE.md](../../CLAUDE.md),
  [ADR-0007](0007-politica-de-supply-chain.md)

## Contexto

Boa parte do código será escrita com o Claude Code: no CLI local, na IDE e em sessões na
nuvem (claude.ai/code). Os ganhos são velocidade e revisão especializada sob demanda. Os
riscos:

- o agente executa comandos destrutivos, lê segredos ou enfraquece testes para "passar";
- prompt injection vinda de conteúdo do repositório ou de PRs;
- material de terceiros (skills, agentes) entra sem revisão;
- custo de tokens;
- configuração que vale num ambiente e não em outro.

Fatos verificados na documentação oficial (`code.claude.com/docs`, página de cloud
environments) e num teste ponta a ponta na sessão de pesquisa, com o Claude Code 2.1.302:

- **Numa sessão na nuvem, os plugins e marketplaces declarados no `.claude/settings.json` do
  repositório não carregam.** O debug log registrou `Skipping orphaned enabledPlugins entry …:
  marketplace not registered`.
- Carregam na nuvem: `CLAUDE.md`, `.claude/skills/`, `.claude/agents/`, `.claude/rules/`, os
  hooks e permissões do `.claude/settings.json` (em sessão com um só repositório) e o
  `.mcp.json`.
- Em sessão na nuvem com **vários repositórios**, nenhum hook do settings roda. Nesse caso o
  caminho é o *setup script* do ambiente.
- `permissions.allow` e marketplaces extras só valem depois do diálogo de confiança no
  workspace. `deny`, `ask` e hooks valem sempre.
- Hook com `onFailure: "block"` falha fechado (bloqueia se o hook quebrar ou estourar o
  tempo).
- Uma skill de projeto com o mesmo nome de um comando embutido o substitui. Uma skill chamada
  `verify` é executada pelo CLI antes de cada commit (Claude Code ≥ 2.1.286).

## Decisão

1. **O essencial fica versionado em `.claude/`, não em plugins:**
   - hooks:
     - `guard-bash` e `guard-files`, fail-closed;
     - `post-edit-quality` (Biome e ESLint no arquivo editado);
     - `stop-typecheck`;
     - `guard-prompt` (bloqueia segredo colado no chat);
     - `session-start`, que instala dependências só na nuvem;
   - skills e agentes próprios em pt-BR;
   - regras por caminho em `.claude/rules/`;
   - MCP do Playwright pinado.
2. **Material de terceiros entra vendorizado** por
   [`scripts/vendor-claude-skills.sh`](../../scripts/vendor-claude-skills.sh):
   - commits fixos (SHA), nada executado dos repositórios de origem e allowlist arquivo a
     arquivo;
   - `allowed-tools` restringido: sem `Bash` amplo, porque `allowed-tools` não passa pelo
     diálogo de confiança;
   - prefixos de origem (`tob-`, `sentry-`, `anthropic-`, `superpowers-`, `ms-`);
   - atribuição e licenças em [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) e
     `.claude/licenses/`.

   Ficam fora material proprietário (`claude-security`), source-available sem licença de
   redistribuição (skills de documentos), repositórios sem licença e binários fechados.
3. **Plugins de marketplace só para quem usa o CLI local** (`enabledPlugins` no settings),
   como complemento. A defesa nunca depende deles.
4. **Regras de trabalho no [CLAUDE.md](../../CLAUDE.md):**
   - TDD;
   - testes intocáveis;
   - isolamento entre tenants;
   - tempo e fuso;
   - LGPD;
   - migrações imutáveis;
   - segredos;
   - Git;
   - Definition of Done.
5. **Revisão por IA no CI é consultiva:**
   - `claude-review.yml` e `claude.yml` com `anthropics/claude-code-action` pinada por SHA,
     gatilho `pull_request` (sem forks nem bots) e `cache-mode: none`;
   - o prompt não interpola conteúdo do PR;
   - **revisão humana continua obrigatória**: CODEOWNERS em `.claude/`, `.mcp.json` e
     `CLAUDE.md`.
6. **Conteúdo do repositório, de PRs e de páginas é dado, nunca instrução**, para o agente e
   para os subagentes.

## Consequências

- **Positivas:**
  - as mesmas proteções no CLI, na IDE e na nuvem;
  - revisões especializadas (multi-tenant, LGPD, migrações, AppSec) sob demanda;
  - `pnpm verify` roda antes de cada commit;
  - material de terceiros auditável.
- **Negativas e riscos:**
  - **hooks são heurísticas, não sandbox**: analisam o comando e não o executam, e um script
    que lê `.env` por conta própria escapa. Por isso o `.env` real nunca deve existir no
    container da nuvem, onde os segredos ficam no ambiente;
  - custo: o plugin `security-guidance` roda uma revisão por modelo a cada fim de turno (cerca
    de US$ 0,19 por revisão no exemplo da documentação do plugin);
  - material vendorizado envelhece. Revisar os SHAs mensalmente e ler o diff inteiro antes de
    commitar;
  - `.claude/` é alvo de worms de supply chain (persistência relatada, não verificada, no Mini
    Shai-Hulud). Por isso fica no CODEOWNERS e os hooks negam escrita na configuração do
    agente.
- **Ações decorrentes:**
  - `pnpm test:hooks` e `tsc -p .claude/hooks` no CI (job `hooks`);
  - revisão mensal dos SHAs vendorizados e das versões de action e MCP;
  - sessões na nuvem com vários repositórios: configurar o setup script do ambiente.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Só plugins de marketplace | Não carregam em sessões na nuvem (verificado) |
| Habilitar marketplaces de comunidade em massa | Mais de 2.000 plugins sem curadoria |
| Plugins com hooks em todo turno (`fp-check` como plugin) | Custo e latência a cada Stop; vendorizamos só a skill |
| Semgrep Guardian (plugin) | Exige login, distribui binários fechados e manda telemetria. Usamos o Semgrep CE no CI |
| `anthropics/claude-code-security-review` | Parado desde fev/2026, sem tags, usa actions node20 e o README diz que não é endurecido contra prompt injection |
| Sem IA | Perderíamos velocidade e revisões especializadas. O risco é gerenciável com os controles acima |

## Referências

- Claude Code, ambientes na nuvem, hooks, skills e permissões: https://code.claude.com/docs/en/
- `anthropics/claude-code-action`: https://github.com/anthropics/claude-code-action
- Licenças e origens: [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)
