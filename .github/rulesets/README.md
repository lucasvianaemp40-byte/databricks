# Configuração do repositório no GitHub

O que os arquivos de `.github/` pressupõem e que só se configura pela interface (ou pela API).
Nada aqui é aplicado automaticamente: siga a lista ao criar ou revisar o repositório.

## 1. Branch padrão e ruleset

1. A branch padrão deve se chamar `main`: os workflows disparam em `push` para `main`, e os
   templates de issue apontam para `blob/main/SECURITY.md`.
2. Importe `main.json` em **Settings > Rules > Rulesets > New ruleset > Import a ruleset**.
   O ruleset vale para a branch padrão (`~DEFAULT_BRANCH`) e:
   - bloqueia exclusão e force-push e exige histórico linear;
   - exige **commits assinados** (squash pela interface do GitHub já sai assinado; o Renovate
     usa `platformCommit` e o Claude usa `use_commit_signing`);
   - exige PR com squash e todas as conversas resolvidas;
   - exige os checks `ci-ok` (ci.yml) e `security-ok` (security.yml), ambos vindos do app
     GitHub Actions (`integration_id` 15368), o que impede outro app de forjar o status.
     Cada um agrega os jobs do seu workflow, então renomear ou criar jobs não exige mexer no
     ruleset.
   - **Sem bypass para ninguém**, inclusive administradores.
3. Projeto com uma pessoa só: `required_approving_review_count: 0` e
   `require_code_owner_review: false`, porque ninguém aprova o próprio PR. Quando entrar a
   segunda pessoa, suba para `1` e `true` e ligue `require_last_push_approval`.
4. Com GitHub Code Security (`GHAS_ENABLED = true`), acrescente a regra de code scanning:

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
  `actions/*, github/codeql-action/*, pnpm/action-setup, google/osv-scanner-action/*,
  aquasecurity/trivy-action, ossf/scorecard-action, zaproxy/action-baseline,
  zizmorcore/zizmor-action, anthropics/claude-code-action`.
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
- **Private vulnerability reporting**: ligado (é o canal do `SECURITY.md`).
- **Code scanning:** use o `codeql.yml` (advanced setup); não ligue também o "Default setup".

## 4. Variáveis e segredos (Settings > Secrets and variables > Actions)

| Nome | Tipo | Uso |
|---|---|---|
| `GHAS_ENABLED` | variável | `true` em repositório público ou com GitHub Code Security: liga CodeQL, Scorecard, dependency-review e o upload de SARIF. Sem ela, os scanners bloqueiam pelo exit code e os relatórios ficam como artefato do run. |
| `SCORECARD_PUBLISH` | variável | `true` só em repositório público: publica o resultado do Scorecard (badge e API do OpenSSF). |
| `CLAUDE_REVIEW_MODEL`, `CLAUDE_MODEL` | variáveis (opcionais) | Modelo do Claude na revisão de PR e no `@claude`. Padrão: `claude-opus-5-5`. |
| `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN` | segredo | Liga `claude-review.yml` e `claude.yml`. Sem ele, os jobs ficam pulados. Use uma chave dedicada ao CI, com limite de gasto no Console. |

Risco residual conhecido: segredo de repositório fica disponível a workflows de PR do próprio
repositório. Quem tem permissão de escrita poderia lê-lo com um workflow alterado no PR. A
mitigação é o CODEOWNERS em `.github/`, a lista curta de colaboradores e a chave com limite de
gasto. O zizmor (persona `auditor`) aponta isso como `secrets-outside-env`.

## 5. Ainda não configurado

- **Deploy** (`deploy.yml`): fica para quando houver alvo definido. Desenho previsto: build sem
  privilégio num job, deploy noutro com `environment: production` (revisores obrigatórios, só
  `main`), OIDC (`id-token: write`) para a nuvem, `cache-mode: none` e nenhum `pnpm install` no
  job privilegiado.
- **DAST contra preview/staging**: depende do deploy. O `dast.yml` atual varre o build de
  produção subido no próprio runner.
- **Workflow lockfiles** (`gh actions-lock`, preview desde 2026-10-14): só GitHub Enterprise
  Cloud. Até lá, os pins por SHA e o Renovate cumprem esse papel.
