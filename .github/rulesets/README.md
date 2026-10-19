# Configuração do repositório no GitHub

O que os arquivos de `.github/` pressupõem e que só se configura pela interface (ou pela API).
Nada aqui é aplicado automaticamente: siga a lista ao criar ou revisar o repositório. Quem
aplica é o dono do repositório; agentes só documentam e listam o que falta no PR.

## 0. Bootstrap (repositório que já existe, com branch padrão diferente de `main`)

Caso deste repositório na primeira entrega: a branch padrão é uma branch antiga
(`claude/databricks-refat-jobs-list-lzssir`, só com `.gitignore` e um script), sem `main`, sem
workflows e sem ruleset. Enquanto for assim, os gatilhos `push: branches: [main]` não disparam
e os crons não rodam (agendamento só vale com o workflow na branch padrão). Em ordem:

1. Crie `main` a partir do commit atual da branch padrão (assim o diff do PR da fundação não
   muda) e torne-a a branch padrão (**Settings > General > Default branch**). Alternativa:
   renomeie a branch padrão para `main` (os PRs abertos são reapontados).
2. Reaponte a base do PR da fundação para `main`.
3. Ligue já o **private vulnerability reporting**, o secret scanning, o push protection e o
   dependency graph (seção 3): o repositório é público, o `SECURITY.md` aponta o relato
   privado como único canal e o job `dependency-review` (parte do `security-ok`) falha sem o
   dependency graph.
4. Crie as variáveis da seção 4 (`SCORECARD_PUBLISH=true`; `GHAS_ENABLED` só se o repositório
   for privado sem GitHub Code Security).
5. Em **Settings > General > Pull Requests**: deixe só "Allow squash merging", com "Default
   commit message" = **Pull request title** (`squash_merge_commit_title=PR_TITLE`). Só squash
   é redundante com o `allowed_merge_methods` do ruleset, mas vale também enquanto o ruleset
   não existe. O check `pr-title` (`pr-title.yml`) passa esse título no commitlint e roda de
   novo a cada edição do PR (evento `edited`), lendo o título atual pela API. Ele cobre a
   mensagem padrão, não a final: o diálogo de squash ainda deixa quem faz o merge editar o
   texto.
6. Instale o app do Renovate com leitura de "Dependabot alerts".
7. Importe `main.json` (item 2 da seção 1) **só quando `ci-ok`, `security-ok` e `pr-title`
   estiverem verdes no PR da fundação**: o ruleset não tem bypass, e um check vermelho
   bloquearia o próprio PR que traz a correção.
8. Faça o merge (squash) do PR da fundação. No clone local, rode
   `git remote set-head origin --auto`: o hook `guard-files` usa `origin/HEAD` para saber
   quais migrações já estão publicadas.
9. Opcional: apague ou arquive a branch antiga.

## 1. Branch padrão e ruleset

1. A branch padrão deve se chamar `main`: os workflows disparam em `push` para `main`. Os
   templates de issue apontam para `../security/policy`, que segue a branch padrão.
2. Importe `main.json` em **Settings > Rules > Rulesets > New ruleset > Import a ruleset**.
   O ruleset vale para a branch padrão (`~DEFAULT_BRANCH`) e:
   - bloqueia exclusão e force-push e exige histórico linear;
   - exige **commits assinados** (squash pela interface do GitHub já sai assinado; o Renovate
     usa `platformCommit` e o Claude usa `use_commit_signing`);
   - exige PR com squash e todas as conversas resolvidas;
   - exige os checks `ci-ok` (ci.yml), `security-ok` (security.yml) e `pr-title`
     (pr-title.yml), todos vindos do app GitHub Actions (`integration_id` 15368), o que impede
     outro app de forjar o status. `ci-ok` e `security-ok` agregam os jobs do seu workflow,
     então renomear ou criar jobs neles não exige mexer no ruleset. `pr-title` fica num
     workflow à parte porque precisa rodar quando o título é editado sem push (evento
     `edited`), e pôr esse evento no ci.yml refaria o CI inteiro a cada edição da descrição.
   - **Sem bypass para ninguém**, inclusive administradores.
3. Projeto com uma pessoa só: `required_approving_review_count: 0` e
   `require_code_owner_review: false`, porque ninguém aprova o próprio PR. Quando entrar a
   segunda pessoa, suba para `1` e `true` e ligue `require_last_push_approval`.
4. Com code scanning ativo (o padrão: repositório público ou privado com GitHub Code
   Security, ou seja, `GHAS_ENABLED` diferente de `false`), acrescente a regra:

   ```json
   {
     "type": "code_scanning",
     "parameters": {
       "code_scanning_tools": [
         { "tool": "CodeQL", "security_alerts_threshold": "high_or_higher", "alerts_threshold": "errors" }
       ]
     }
   }
   ```

Os nomes de campo seguem a API REST de rulesets; o import valida o arquivo. Rulesets em
repositório privado exigem plano pago (Pro, Team ou superior).

## 2. Actions (Settings > Actions > General)

- **Actions permissions:** "Allow *owner*, and select non-*owner*, actions and reusable
  workflows", com a lista:
  `actions/*, github/codeql-action/*, aquasecurity/trivy-action, ossf/scorecard-action,
  zaproxy/action-baseline, zizmorcore/zizmor-action, anthropics/claude-code-action`.
  O pnpm vem do Corepack e o OSV-Scanner de imagem pinada por digest: nenhum dos dois usa
  action de terceiros.
  Ações usadas internamente por elas (setup-trivy, setup-bun etc.) também precisam constar;
  o primeiro run indica as que faltarem.
- Marque **"Require actions to be pinned to a full-length commit SHA"**.
- **Workflow permissions:** "Read repository contents and packages permissions" e
  **desmarque** "Allow GitHub Actions to create and approve pull requests".
- **Fork pull request workflows:** "Require approval for all external contributors".
- Nenhum runner self-hosted.

## 3. Segurança (Settings > Advanced Security)

- **Dependency graph** e **Dependabot alerts**: ligados. O Renovate lê os alertas
  (`vulnerabilityAlerts` no `renovate.json5`); dê ao app do Renovate permissão de leitura de
  "Dependabot alerts".
- **Dependabot security updates** e **version updates**: desligados. Não há
  `.github/dependabot.yml` de propósito: a doc do Dependabot só cobre pnpm até a v10 e os PRs
  duplicariam os do Renovate, que entende o pnpm 11, a quarentena e os pins por SHA/digest.
- **Secret scanning** e **push protection**: ligados (grátis em repositório público; em privado
  exigem GitHub Secret Protection). O gitleaks do CI cobre o mesmo risco nos dois casos.
- **Private vulnerability reporting**: ligado (é o único canal do `SECURITY.md`). Confira:
  `gh api repos/<dono>/<repo>/private-vulnerability-reporting` deve responder
  `{"enabled":true}`.
- **Code scanning:** use o `codeql.yml` (advanced setup); não ligue também o "Default setup".

## 4. Variáveis e segredos (Settings > Secrets and variables > Actions)

| Nome | Tipo | Uso |
|---|---|---|
| `GHAS_ENABLED` | variável (opcional) | Só para repositório **privado sem** GitHub Code Security: `false` desliga CodeQL, Scorecard, dependency-review e o upload de SARIF (os scanners continuam bloqueando pelo exit code e os relatórios ficam como artefato do run). Sem a variável, tudo isso fica ligado: num privado sem Code Security, o upload falha à vista em vez de o controle sumir em silêncio. |
| `SCORECARD_PUBLISH` | variável | `true` só em repositório público: publica o resultado do Scorecard (badge e API do OpenSSF). |
| `CLAUDE_REVIEW_MODEL`, `CLAUDE_MODEL` | variáveis (opcionais) | Modelo do Claude na revisão de PR e no `@claude`. Padrão: `claude-opus-5-5`. |
| `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN` | segredo | Liga `claude-review.yml` e `claude.yml`. Sem ele, os jobs ficam pulados. Use uma chave dedicada ao CI, com limite de gasto no Console. |

Risco residual conhecido: segredo de repositório fica disponível a workflows de PR do próprio
repositório (PR de fork não recebe segredo). Quem tem permissão de escrita pode lê-lo com um
workflow alterado no próprio PR: o run usa o workflow do PR e acontece antes de qualquer
revisão. Hoje o CODEOWNERS não mitiga isso: com `required_approving_review_count: 0` e
`require_code_owner_review: false` (seção 1), ele não bloqueia nenhum merge. O que reduz o
risco hoje:

- **Lista curta de colaboradores com escrita.** Só eles abrem PR de branch do próprio
  repositório. Revise em **Settings > Collaborators** (em organização, **Collaborators and
  teams**).
- **Chave dedicada ao CI, num workspace do Console da Anthropic com limite de gasto:** um
  vazamento custa no máximo o limite. Prefira `ANTHROPIC_API_KEY` ao `CLAUDE_CODE_OAUTH_TOKEN`,
  que dá acesso à assinatura de uma pessoa. Revogue e troque a chave se houver suspeita.
- **Quando entrar o segundo mantenedor:** revisão obrigatória de code owner (seção 1, item 3)
  em `.github/`. Isso impede que um workflow alterado chegue à `main` (onde rodaria em push e
  nos agendamentos), mas não impede a leitura no run do próprio PR.

O zizmor (persona `auditor`) aponta isso como `secrets-outside-env`. Fechar o risco de vez
exige um `environment` com revisores obrigatórios para o segredo, o que pede aprovação manual a
cada run da revisão do Claude.

## 5. Ainda não configurado

- **Deploy** (`deploy.yml`): fica para quando houver alvo definido. Desenho previsto: build sem
  privilégio num job, deploy noutro com `environment: production` (revisores obrigatórios, só
  `main`), OIDC (`id-token: write`) para a nuvem, `cache-mode: none` e nenhum `pnpm install` no
  job privilegiado.
- **DAST contra preview/staging**: depende do deploy. O `dast.yml` atual varre o build de
  produção subido no próprio runner.
- **Workflow lockfiles** (`gh actions-lock`, preview desde 2026-10-14): só GitHub Enterprise
  Cloud. Até lá, os pins por SHA e o Renovate cumprem esse papel.
