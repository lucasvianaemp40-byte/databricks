# ADR-0007: Política de cadeia de suprimentos

- **Status:** Aceito
- **Data:** 2026-10-17
- **Relacionados:** [seguranca/supply-chain.md](../seguranca/supply-chain.md) (procedimentos),
  [ADR-0001](0001-monorepo-e-stack.md), [ADR-0008](0008-desenvolvimento-assistido-por-ia.md)

## Contexto

OWASP Top 10:2025 trouxe uma categoria nova, **A03 Software Supply Chain Failures**. Os
incidentes de 2025–2026 mostram os mecanismos de ataque:

| Data | Incidente | Mecanismo | Controle |
|---|---|---|---|
| mar/2025 | `tj-actions/changed-files` (CVE-2025-30066) | tags da action movidas para um commit que despejava segredos no log | pin por SHA completo |
| set/2025 | `chalk`/`debug` e outros 16 pacotes | conta de mantenedor phishada; versões retiradas em ~1–2 h | quarentena de versões; `trustPolicy` |
| set e nov/2025 | Shai-Hulud 1 e 2 | script de install rouba tokens e publica sozinho | scripts de dependência bloqueados |
| mar/2026 | `axios` 1.14.1 e 0.30.4 | dependência nova com `postinstall` (RAT); retiradas em ~3 h | scripts bloqueados + quarentena |
| mar/2026 | Trivy / `trivy-action` | tags forçadas para versões que roubam credenciais | pin por SHA; versão do scanner explícita |
| mai/2026 | TanStack ("Mini Shai-Hulud") | `pull_request_target` com checkout de fork, depois cache do store envenenado, depois token OIDC extraído no job de release | nada de `pull_request_target`; `cache-mode: none` em job privilegiado; build separado do deploy |

O postmortem primário da TanStack está em `TanStack/tanstack.com`
(`src/blog/npm-supply-chain-compromise-postmortem.md`). Os outros incidentes vêm de fontes
secundárias, listadas em [supply-chain.md](../seguranca/supply-chain.md#referências).

## Decisão

**Dependências npm (pnpm 11, em [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml)):**

- `minimumReleaseAge: 4320` (3 dias) com `minimumReleaseAgeStrict: true`. Exceções em
  `minimumReleaseAgeExclude` só com justificativa no PR, para hotfix de segurança.
- `trustPolicy: no-downgrade`: falha se o nível de confiança cair (trusted publisher >
  provenance > nada). A única exceção, `semver@6.3.1`, é um backport legítimo de 2023
  publicado à mão.
- `blockExoticSubdeps: true`: dependência transitiva não pode vir de git nem de URL de
  tarball.
- `strictDepBuilds: true` com `allowBuilds` explícito. Hoje `esbuild` e `lefthook` estão
  **negados**: o binário chega por optionalDependency e os hooks Git são instalados com
  `pnpm hooks:install`. **Nunca** usar `dangerouslyAllowAllBuilds`.
- `saveExact`, `engineStrict` e `strictPeerDependencies`; catálogo único de versões.
- `audit.ignore` só com justificativa e `ignorePrune`. Hoje há dois advisories de
  ferramentas de desenvolvimento sem caminho a partir de entrada de usuário:
  `GHSA-vfj7-8cjw-p6xm` (braces, via `@next/eslint-plugin-next`) e `GHSA-67mh-4wv8-2f99`
  (servidor de dev do esbuild, via drizzle-kit). Todo risco aceito fica espelhado em **três**
  lugares, com a mesma justificativa: `audit.ignore`, `.github/osv-scanner.toml` (com
  `ignoreUntil`) e `allow-ghsas` do dependency-review
  ([procedimento](../seguranca/supply-chain.md#advisory-sem-correção)).
- `packageManager` com hash sha512, conferido contra a integrity do registry e checado pelo
  Corepack na máquina e no CI (`.github/actions/setup` usa `corepack enable pnpm`, não uma
  action de terceiros). Lockfile de um documento só.

**Atualizações: Mend Renovate App** ([`renovate.json5`](../../renovate.json5)):

- `config:best-practices`;
- npm com 3 dias de quarentena e `internalChecksFilter: strict`;
- actions, imagens e ferramentas com **7 dias**;
- majors com 14 dias e aprovação manual no Dependency Dashboard;
- PR de vulnerabilidade sem quarentena nem agendamento;
- `platformCommit` para commits assinados;
- grupos para Next/React, Drizzle/pg, testes, lint e ferramentas de segurança.

O Dependabot continua com os **alertas** ligados, porque o Renovate os lê, mas não abre PRs:
a documentação dele só cobre pnpm até a v10.

**GitHub Actions:**

- toda `uses:` pinada por SHA completo, com `# vX.Y.Z`;
- imagens (`services:`, `container:`, `docker run`) pinadas por digest;
- `permissions: {}` no topo e o mínimo por job;
- `persist-credentials: false`;
- sem `${{ }}` dentro de `run:`;
- sem `pull_request_target` e sem `workflow_run` que execute código de PR;
- `cache-mode: none` em job com segredo ou `id-token`;
- `timeout-minutes` em todo job.

**Repositório:**

- ruleset na branch padrão com commits assinados, PR com squash, histórico linear, sem
  force-push e sem bypass;
- checks obrigatórios `ci-ok`, `security-ok` e `pr-title`, vindos só do app GitHub Actions;
- CODEOWNERS em `.github/`, `.claude/`, `CLAUDE.md`, `.mcp.json`, manifestos, lockfile,
  configuração de scanners e `packages/db/`. Com uma pessoa no projeto, ele só identifica o
  dono: o ruleset fica com `required_approving_review_count: 0` e
  `require_code_owner_review: false`, porque ninguém aprova o próprio PR. A revisão
  obrigatória de code owner entra com o segundo mantenedor
  ([.github/rulesets/README.md](../../.github/rulesets/README.md#1-branch-padrão-e-ruleset)).

**Varreduras** ([`security.yml`](../../.github/workflows/security.yml)):

| Ferramenta | Alvo |
|---|---|
| gitleaks (CLI pinado por digest) | segredos, com regras para CPF, CNPJ e tokens de PSP e Meta |
| Semgrep | SAST, com regras próprias de multi-tenant, LGPD e fuso |
| OSV-Scanner | job próprio, com o binário extraído da imagem pinada por digest e decisão pelo exit code em `.github/scripts/osv-gate.sh`: no PR, só falha o que o PR acrescenta em relação à base; nos demais eventos, varredura completa |
| Trivy fs | vulnerabilidades (dependências de produção do `pnpm-lock.yaml`). O scanner de misconfig fica desligado até existir Dockerfile ou IaC |
| zizmor, actionlint e shellcheck | workflows, a ação composta e os scripts `*.sh` versionados (menos as skills de terceiros) |
| `pnpm audit signatures`, `pnpm audit --audit-level high`, `pnpm sbom` (CycloneDX) | dependências do pnpm |
| CodeQL, Scorecard, dependency-review e upload de SARIF | **ligados por padrão**. `GHAS_ENABLED=false` só em repositório privado sem GitHub Code Security: aí os scanners continuam bloqueando pelo exit code e os relatórios ficam como artefato |

## Consequências

- **Positivas:**
  - versões maliciosas costumam ser retiradas em horas, e a quarentena de 3 dias absorve a
    maioria dos casos conhecidos;
  - script de instalação novo trava o install até ser revisado;
  - tags mutáveis de actions deixam de ser vetor.
- **Negativas e riscos:**
  - correção de segurança de dependência leva até 3 dias, a menos que se use a exceção
    pontual (procedimento em [supply-chain.md](../seguranca/supply-chain.md#hotfix-de-segurança-fora-da-quarentena));
  - o `trustPolicy` pode barrar releases legítimas sem provenance (caso do lefthook 2.2.2):
    cada exceção exige análise;
  - CodeQL, upload de SARIF, dependency-review e Scorecard exigem GitHub Code Security em repo
    privado. Ficam ligados por padrão: num repositório privado sem Code Security o upload falha
    à vista até alguém definir `GHAS_ENABLED=false`, em vez de o controle sumir em silêncio;
  - risco aceito mantido em três lugares (`audit.ignore`, `osv-scanner.toml` e `allow-ghsas`)
    pode divergir. O cabeçalho do `osv-scanner.toml` lembra a regra.
- **Ações decorrentes:**
  - revisar os pins atrasados pela quarentena (Next 16.4.2, React 19.3.1, Vitest 5.0.5,
    ESLint 10.13.0, Turbo 2.11.9, Playwright 1.64.1, axe 4.14.0);
  - reavaliar o lefthook quando sair release com provenance;
  - aplicar as configurações de interface listadas em
    [.github/rulesets/README.md](../../.github/rulesets/README.md), começando pela seção
    "0. Bootstrap" (em 2026-10-19, só a branch `main` existia, ainda sem ser a padrão; o resto
    não estava aplicado).

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Dependabot para updates | Não documenta o pnpm 11, não aplica a quarentena do pnpm e não mantém pins por digest com a mesma flexibilidade |
| Pin por tag (`@v4`) | Tags são mutáveis (tj-actions, trivy-action) |
| `gitleaks-action` | Exige licença para repositório de organização e embute o gitleaks 8.24.3, antigo. Usamos o CLI pinado por digest |
| `semgrep-action` | Obsoleta. Usamos a imagem oficial pinada por digest |
| Harden-Runner | Gratuito só em repositório público. Opcional |
| Workflow lockfiles do GitHub | Só no GitHub Enterprise Cloud (preview desde 14/10/2026) |

## Referências

- OWASP Top 10:2025, A03: https://owasp.org/Top10/2025/
- Configurações de supply chain do pnpm: https://github.com/pnpm/pnpm.io (`docs/supply-chain-security.md`, `docs/settings/`)
- Opções do Renovate: https://docs.renovatebot.com/configuration-options/
- GitHub, uso seguro de `pull_request_target` e `cache-mode`: fonte em https://github.com/github/docs
