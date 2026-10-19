# Ambiente do Claude Code (.claude/)

Configuração versionada do Claude Code para o Agenda Salão. Vale no CLI local, na IDE e nas
sessões na nuvem (claude.ai/code). Na nuvem, os plugins dependem do marketplace estar
registrado no container: numa sessão verificada, os do `claude-plugins-official` carregaram e
os da `trailofbits` não (ver [Plugins](#plugins)). Por isso o essencial (skills e agentes de
revisão) está vendorizado aqui.

## Estrutura

| Caminho | Conteúdo |
| --- | --- |
| `settings.json` | permissões (deny/ask/allow), hooks, env (`TZ=UTC`, telemetria desligada), marketplaces e plugins, MCP aprovado |
| `hooks/` | guardas e automações (Node, sem dependências); testes em `hooks/test/` |
| `mcp/` | `playwright-mcp.sh`, que inicia o servidor MCP do Playwright declarado em `.mcp.json` |
| `agents/` | subagentes do projeto (pt-BR) e de terceiros (`tob-`, `anthropic-`) |
| `skills/` | skills do projeto (pt-BR) e de terceiros (`tob-`, `sentry-`, `superpowers-`, `ms-`) |
| `rules/` | regras curtas carregadas só ao tocar banco, domínio ou servidor web |
| `claude-security-guidance.md` | regras de segurança do domínio lidas pelo plugin `security-guidance` |
| `licenses/` | licenças dos materiais de terceiros (ver `THIRD_PARTY_NOTICES.md`) |

## Hooks

| Evento | Script | Comportamento |
| --- | --- | --- |
| PreToolUse `Bash\|Monitor` | `guard-bash.mjs` | analisa o `command` do Bash e do Monitor (o Monitor roda um script de shell no mesmo ambiente do Bash; a fonte `ws`, WebSocket sem shell, passa sem decisão). Nega comandos destrutivos, `sudo`, `curl \| sh`, force-push, push para main (inclusive por `remote.*.push`, `mirror`, `push.default`/`branch.*.merge`, na linha de comando ou na configuração do repositório, por refspec com curinga e depois de `git checkout`/`git switch` para main na mesma linha, inclusive branch criada com upstream main, como `-t origin/main`, `-b x origin/main` e `git branch -u origin/main`, seguida de `git push` sem refspec), `--no-verify` (inclusive abreviado; opções longas do git são resolvidas por prefixo único como o parse-options faz, `--mi` = `--mirror`, e prefixo ambíguo que pode ser opção protegida, como `--forc`, é negado), `LEFTHOOK=0`/`HUSKY=0` (inclusive por `declare`, `readonly`, `printf -v`, `read`) e `LEFTHOOK_BIN`/`LEFTHOOK_CONFIG`/`LEFTHOOK_EXCLUDE`/`SKIP` com qualquer valor, `core.hooksPath`/`include.path`/`GIT_CONFIG_GLOBAL`, configs e subcomandos git que executam comando perigoso (`-c core.fsmonitor`, `core.sshCommand`, `rebase -x`, `bisect run`, `submodule foreach`, `GIT_SSH_COMMAND`), leitura de segredos (também por variável, `$(...)`, crases, substituição de processo, `xargs`, inclusive `-a` agrupado como `-ra .env` e `--arg=.env`, segredo executado como comando, como `./.env` e `xargs .env`, expansão de chaves com sequência, como `.e{n..n}v`, `sed r/w/e`, `awk getline`, `script -c` e script gerado por `echo ... \| sh`), despejo do ambiente (`env`, `/proc/*/environ`, inclusive por redirecionamento e depois de `cd /proc/self`, `process.env` e equivalentes em Python, Ruby, PHP, awk e jq, inclusive `php -i`), código inline de interpretadores e shells lido com a tabela de opções de cada um (`lib/cli-options.mjs`: agrupadas como `python3 -Ic`, `perl -lne`, `php -nr`; anexadas como `-cCODE`; depois de opção com valor, como `node -r x -e`, `perl -I lib -e`, `bash -eo pipefail -c`, `bash -c -e`; código no `-M` do perl, `perl -M'x;...' -e1`; `fish -C`; URL `data:` em `node --import`/`-r` e em `NODE_OPTIONS`; nomes com versão como `python3.13`, `php8.3`; agrupamento desconhecido pede confirmação), também atrás de wrappers (`env -S`, `setsid`, `nohup`, `timeout`, `strace`, `taskset`, `corepack`), histórico do shell e estado do Claude Code (`~/.claude.json`, transcrições `~/.claude/projects/**/*.jsonl`), escrita em lockfile, em migração publicada e na configuração do agente — a do projeto e a do escopo do usuário (`~/.claude/settings.json` e `settings.local.json`, por `~`, caminho absoluto ou `cd ~/.claude`) — (também por `cd` + caminho relativo, glob que expande para ela (`.claude/se*`), `--target-directory`/`-t` de `cp`/`mv`/`install`/`ln` apontando para `.claude/hooks`, membro de `tar`, `git restore --source`/`rm`/`mv`, `git checkout <commit> -- <arquivo>`, `git stash push -- <arquivo>`, `find -exec`, `sh -c`, interpretadores (inclusive script lido de `/dev/stdin`), `sed -i`/`--in`, `perl -pi`, `tee`, `dd of=`, `truncate`, `ln -sf`, `ex`/`vim` em lote sobre o arquivo passado como argumento (`vim -es -c wq <arquivo>`) e o comando de shell de `:!`/`:r !` em `-c`, `--cmd` ou `+cmd`, `awk -i inplace`, `find -fprint`, `sort -o`). Pede confirmação para SQL destrutivo, migração/reset de banco, deploy, dependência nova, configs git que executam comando (inclusive o transporte `ext::` liberado por `protocol.allow`, `protocol.<nome>.allow` ou `GIT_ALLOW_PROTOCOL`), `git push --all`, sandboxes que executam outro comando (`unshare`, `bwrap`, `firejail`), escrita em configuração de hooks git/MCP, destino que não dá para resolver (`> "$HOME/.claude/settings.json"`, `$CLAUDE_CONFIG_DIR`), extração ou cópia para dentro de `.claude/` (`tar -C`, `unzip -d`, `cp -r`, `cp`/`mv`/`install` para a pasta, inclusive `-t .claude`, `rsync`, `git checkout -- .claude`), `git apply` (sempre: o guarda não vê o conteúdo do patch), `patch` que cita a configuração protegida, shell chamado pelo vim (`:!`, `:w !cmd`, `system()`) e subcomandos do `playwright cli` que executam código ou mexem em sessão (`run-code`, `eval`, `state-*`, cookies). Fail-closed (`onFailure: block` e erro interno vira `deny`). |
| PreToolUse `Read\|Edit\|Write\|MultiEdit\|NotebookEdit\|Grep` | `guard-files.mjs` | nega `.env*` (exceto `.env.example`), chaves, certificados, diretórios de credenciais, `/proc/*/environ`, histórico do shell e estado do Claude Code (inclusive via link simbólico); no Grep, avalia cada parte do glob (vírgula, espaço, chaves e sequência: `{.env,x}`, `.e{n..n}v`), e glob com chaves que não dá para expandir inteiro (acima de 64 alternativas) é negado; nega edição manual de lockfile e de migração que já está na branch padrão; pede confirmação para `_journal.json`, para escrever configuração de hooks git e do MCP (`lefthook*`, `.lefthook-local.*`, `.husky/`, `.git/hooks`, `.git/config`, `.mcp.json`, `.claude/mcp/`), para alterar a configuração do Claude Code no escopo do usuário (`~/.claude/settings.json` e `settings.local.json`) e para acrescentar dica de exclusão de cobertura (`v8`/`c8`/`istanbul ignore`, `node:coverage`) em `src/`, `test/` ou `e2e/` de um pacote. A escrita em `.claude/settings*.json` e `.claude/hooks/` pelas ferramentas de arquivo também pede confirmação pelo próprio hook (na nuvem as ferramentas de arquivo rodam sem perguntar em qualquer modo, então a regra nativa `permissions.ask` sozinha não protege); por Bash, é negada. Fail-closed. |
| PostToolUse `Edit\|Write\|MultiEdit` | `post-edit-quality.mjs` | `biome check --write` e ESLint (`--fix --max-warnings=0`) só no arquivo editado; problema restante volta para o Claude (exit 2). |
| Stop | `stop-typecheck.mjs` | typecheck (turbo, com cache) só dos pacotes com arquivos alterados e seus dependentes; erro bloqueia o encerramento uma vez (`stop_hook_active`). |
| UserPromptSubmit | `guard-prompt.mjs` | bloqueia prompt com segredo colado (chave, token, URL de banco com senha) e suprime o texto. |
| SessionStart `startup\|resume` | `session-start.sh` | só na nuvem (`CLAUDE_CODE_REMOTE=true`): ativa o pnpm via corepack e roda `pnpm install --frozen-lockfile` quando o hash de lockfile/manifests muda. Nunca falha a sessão. |

Duas camadas para arquivos: as regras nativas `Read(...)` de `permissions.deny` e o
`guard-files`. Numa busca em diretório (Grep sem glob, ou com `*`, `.*`) o hook só vê o glob;
quem tira os segredos do resultado são as regras nativas, que o Claude Code converte em
exclusões do ripgrep. `hooks/test/settings-deny.test.mjs` falha se as duas listas divergirem.

Limites conhecidos:

- Os guardas analisam o comando, não o executam: são defesa em profundidade, não sandbox. A
  análise de indireção é de melhor esforço: valores montados em tempo de execução
  (concatenação dentro de um programa, `node script.mjs` ou `make` que leem `.env` por conta
  própria, conteúdo de patch ou de tar desconhecido) não são vistos. Quando o destino não
  pode ser resolvido (`cd "$DIR"`, `xargs` sobre lista desconhecida), o guarda pede
  confirmação. Para isolamento real, use o sandbox nativo do Claude Code (`/sandbox`) e mantenha
  `.env` real fora do container da nuvem (use os segredos do ambiente).
- Expansão de chaves: o `guard-bash` expande listas e sequências (`{a,b}`, `{1..3}`, `{a..c}`)
  como o bash 5.2, até 64 palavras. Acima disso, o comando pede confirmação (erro de análise),
  a palavra original é reavaliada como glob (sob `.claude/` é negada) e o que ficou de fora da
  expansão ainda é analisado quando é palavra completa ou tem um grupo só
  (`cat {{1..64},.env}` e `cat {{1..64},.e{n,x}v}` são negados). Alternativa perigosa com
  mais de um grupo além do teto só pede confirmação. Efeito colateral aceito: laço numérico
  acima de 64 (`for i in {1..100}; do ...; done`) também pede confirmação.
- `git stash push -- <arquivo>` é tratado como escrita no arquivo. `git stash` sem caminho,
  `git stash pop` e `git stash apply` trocam a árvore inteira, como trocar de branch, e não
  são analisados.
- As regras `Read(...)` valem para as ferramentas de arquivo, não para subprocessos do Bash
  nem para o script do Monitor: ali quem protege é o `guard-bash`. Numa sessão real de
  2026-10-18, `Monitor` com `cat .env.<sonda>` foi negado pelo `guard-bash`
  (`PreToolUse:Monitor`). **Não verificado:** se as regras nativas `Bash(...)` de
  `permissions` valem também para o Monitor; conte só com o hook.
  `hooks/test/kit-wiring.test.mjs` falha se o matcher deixar de cobrir `Bash` ou `Monitor`.
- No vim/ex, o guarda vê o arquivo passado como argumento e o shell de `:!` em `-c`, `--cmd`
  ou `+cmd` separados. Não vê (sondado em 2026-10-18; correção pendente em
  `lib/bash-policy.mjs`): comando Ex que lê ou grava outro arquivo dentro de `-c`/`+cmd`
  (`vim -es -c 'w .claude/settings.json' -c q x`, `:saveas`, `:e .env`, `:r .env`), nem o
  valor de `-c` agrupado com outra opção (`ex -sc '!cmd'`, `vim -esc '!cmd'`).
- Código inline que chama o shell (`perl -e 'print qx(cat .env)'`, `system(...)`) pede
  confirmação sem analisar o comando interno: vira `ask`, não `deny`.
- `patch` que não cita o arquivo (`patch -p1 < x.diff`, `patch -d .claude`) passa sem
  decisão: o alvo está no conteúdo do diff, que o guarda não lê. `git apply` sempre pede
  confirmação.
- Cópia para dentro de `.claude/` com o nome do arquivo vindo da origem
  (`cp settings.json .claude/`) pede confirmação em vez de negar.
- As tabelas de opções de `lib/cli-options.mjs` vêm do git 2.43 (`git <sub>
  --git-completion-helper-all`) e do python 3.13, perl 5.38, ruby 3.3, php 8.3 e node 22 do
  container. Letra nova de interpretador e opção longa fora da tabela no `git push` pedem
  confirmação; nos demais subcomandos do git, uma opção perigosa nova só é reconhecida depois
  que a tabela for atualizada.
- A ferramenta PowerShell não é coberta (o projeto é Linux/macOS).
- A imutabilidade de migrações depende de existir a branch padrão local (`origin/HEAD`,
  `origin/main` ou `main`); o `session-start.sh` tenta `git remote set-head origin --auto`.
- Em sessão na nuvem com vários repositórios, hooks de `.claude/settings.json` não rodam: use
  o setup script do ambiente.

Testes: `pnpm test:hooks` (node:test) e `pnpm exec tsc -p .claude/hooks` (tipos via JSDoc).
O script do pnpm liga o reporter `scripts/no-disabled-tests-reporter.mjs`, que reprova a
execução quando algum teste ou suíte termina pulado ou pendente (inclusive sob `biome-ignore`
e com `t.skip()` em execução); `node --test .claude/hooks/test` direto não passa por esse
portão.

## MCP

`.mcp.json` declara só o `playwright`, iniciado por `.claude/mcp/playwright-mcp.sh`. O wrapper
usa o Playwright do app, travado no `pnpm-lock.yaml`
(`pnpm --filter @salon/web exec playwright mcp`), sem `npx` e sem download. Ele roda headless,
com perfil isolado (`--isolated`) e service workers bloqueados. A saída vai para
`test-results/playwright-mcp`, e as origens ficam limitadas a `localhost:3000` e
`127.0.0.1:3000` (dev) e `127.0.0.1:3100` (build do E2E). Sem segredos.

- Chromium: se o da versão do Playwright não estiver baixado, o wrapper usa a maior revisão
  `chromium-*` em `PLAYWRIGHT_BROWSERS_PATH` (padrão `/opt/pw-browsers`, o do container da
  nuvem) e avisa no stderr. `PLAYWRIGHT_MCP_EXECUTABLE_PATH` força um executável.
- Testes: `PLAYWRIGHT_MCP_PRINT_ARGS=1` só imprime os argumentos (`hooks/test/playwright-mcp.test.mjs`).
- Alterar o wrapper ou o `.mcp.json` pede confirmação (regras `ask` e `guard-files`).
- O agente `qa-engineer` recebe as ferramentas de navegação, inspeção e interação do MCP. Ele
  não recebe `browser_run_code_unsafe` (código no processo do servidor) nem
  `browser_file_upload` (lê arquivo local).

Para automação por linha de comando, a skill `ms-playwright-cli` usa
`pnpm --filter @salon/web exec playwright cli` e não pré-aprova nenhum comando. O `guard-bash`
pede confirmação para `run-code`, `eval`, `state-*`, cookies/storage, `route`, `upload`,
`--filename` e `--config`, e nega `attach`, `--profile` e `--persistent`.

## Plugins

`settings.json` registra os marketplaces `claude-plugins-official` e `trailofbits`. Habilita
`security-guidance`, `claude-security` (scan sob demanda com SARIF; licença proprietária, não
vendorizável), `typescript-lsp` (requer `typescript-language-server` instalado) e
`claude-md-management`. Da Trail of Bits, habilita `insecure-defaults`, `static-analysis`,
`supply-chain-risk-auditor` e `variant-analysis`.

- **Onde carregam.** No CLI local e na IDE, depois que você confia no workspace. Numa sessão
  na nuvem de 2026-10-17, depois de reiniciada, os do `claude-plugins-official` carregaram (o
  marketplace constava em `~/.claude/plugins/known_marketplaces.json`, com cache em
  `~/.claude/plugins/cache`) e os da `trailofbits` não (marketplace não registrado). **Não
  verificado:** se o mesmo vale numa sessão nova, sem cache; a primeira sessão de um ambiente
  pode começar sem plugins. As skills e agentes essenciais estão vendorizados e não dependem
  disso ([ADR-0011](../docs/adr/0011-plugins-e-mcp-na-nuvem.md)).
- **`security-guidance`** roda também na nuvem. Avisa por padrão de código no PostToolUse e
  revisa o diff com um LLM no Stop e em commit/push, com as regras de
  `claude-security-guidance.md`. Cada revisão custa tokens ou uso da assinatura, além da
  sessão, e o revisor padrão é o Opus mais novo. O custo estimado de cada revisão fica no log
  do plugin (`~/.claude/security/log.txt`, campo `est_cost_usd`). Para gastar menos, defina
  `SECURITY_REVIEW_MODEL` (revisão do diff) e `SG_AGENTIC_MODEL` (commit/push) com um modelo
  mais barato. Para desligar camadas, use `ENABLE_STOP_REVIEW=0` ou `ENABLE_COMMIT_REVIEW=0`
  nas variáveis do ambiente (fonte: README e `hooks/security_reminder_hook.py` do plugin
  2.0.14). Quanto gastar é decisão do time.
- **`pr-review-toolkit`** não é habilitado. Os agentes que usamos dele estão vendorizados
  (`anthropic-pr-test-analyzer`, `anthropic-silent-failure-hunter`,
  `anthropic-type-design-analyzer`), e habilitar o plugin duplicaria esses agentes na lista.
  `code-reviewer`, `code-simplifier`, `comment-analyzer` e `/review-pr` ficam de fora. A
  revisão de PR do projeto é a skill `pre-pr`. Regra geral: material vendorizado não é
  habilitado também como plugin.

## Vendorização

`scripts/vendor-claude-skills.sh` baixa commits fixos (sem executar nada dos repositórios) e
copia uma allowlist arquivo a arquivo. Ele reduz `allowed-tools` a leitura ou o remove, e
aborta se qualquer item ficar fora da allowlist `SAFE_ALLOWED_TOOLS`
(`hooks/test/skills-allowed-tools.test.mjs`). Também prefixa nomes e regenera
`THIRD_PARTY_NOTICES.md`. Para atualizar: troque o SHA, rode o script e LEIA o diff inteiro
antes de commitar.
