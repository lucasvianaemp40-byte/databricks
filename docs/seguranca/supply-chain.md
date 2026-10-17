# Cadeia de suprimentos: procedimentos

A política e o porquê estão em [ADR-0007](../adr/0007-politica-de-supply-chain.md). Este
documento diz **como fazer** no dia a dia. As configurações vivem em
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml), [`renovate.json5`](../../renovate.json5),
[`.github/workflows/security.yml`](../../.github/workflows/security.yml) e
[`.github/rulesets/README.md`](../../.github/rulesets/README.md).

## Resumo dos controles

| Camada | Controle | Onde |
|---|---|---|
| Versões novas | quarentena de 3 dias (`minimumReleaseAge: 4320`, estrita) | `pnpm-workspace.yaml` |
| Conta sequestrada | `trustPolicy: no-downgrade` | `pnpm-workspace.yaml` |
| Scripts de instalação | `strictDepBuilds: true` + `allowBuilds` explícito (hoje tudo negado) | `pnpm-workspace.yaml` |
| Fontes exóticas | `blockExoticSubdeps: true` | `pnpm-workspace.yaml` |
| Integridade | lockfile congelado no CI; `pnpm audit signatures` (ECDSA do registry) | `security.yml` |
| Advisories | `pnpm audit --audit-level high`; OSV-Scanner no PR e completo; Trivy | `security.yml` |
| SBOM | `pnpm sbom` CycloneDX como artefato do run | `security.yml` |
| Gerenciador | `packageManager` com hash sha512 (Corepack) | `package.json` |
| Atualizações | Renovate com quarentena (npm 3 dias; actions, imagens e ferramentas 7 dias; majors 14 dias com aprovação) | `renovate.json5` |
| Actions | pin por SHA completo; `permissions` mínimas; sem `pull_request_target`; `cache-mode: none` em job com segredo | `.github/workflows/` |
| Imagens | pin por digest | `.github/workflows/` |
| Workflows | zizmor e actionlint | `security.yml` |
| Segredos | gitleaks (CLI por digest), com regras de CPF, CNPJ e tokens de PSP e Meta | `.gitleaks.toml` |
| Revisão | CODEOWNERS em `.github/`, `.claude/`, manifestos, lockfile e configuração de scanners | `.github/CODEOWNERS` |

## Adicionar uma dependência

Antes, pergunte se precisa mesmo: cada dependência é superfície de ataque.

1. **Justifique no PR:** por que ela, alternativas, quem mantém, frequência de releases,
   licença e tamanho.
2. **Avalie:**
   - `npm view <pacote> time --json`: a versão tem mais de 3 dias?
   - `npm view <pacote> scripts`: tem `preinstall`, `install` ou `postinstall`?
   - publicação com trusted publisher ou provenance? (página do pacote no npm);
   - advisories em https://github.com/advisories;
   - dependências transitivas novas (`pnpm why` depois de instalar).
3. **Instale** com versão exata, pelo catálogo quando for usada em mais de um pacote:

   ```bash
   pnpm --filter @salon/<pacote> add <pacote>@<versão>
   ```

   O `catalogMode: prefer` usa a versão do catálogo quando o pacote já está nele.
4. **Se o install falhar:**

   | Erro | O que significa | O que fazer |
   |---|---|---|
   | quarentena (`minimumReleaseAge`) | versão nova demais | use a mais nova com mais de 3 dias; não crie exceção sem motivo de segurança |
   | `trustPolicy` | o nível de confiança caiu em relação a versões anteriores | **pare e investigue**: pode ser conta sequestrada. Prefira a versão anterior. Exceção só com análise registrada (exemplo: `semver@6.3.1`) |
   | `strictDepBuilds` | o pacote tem script de build | leia o script. Na maioria dos casos o binário vem por optionalDependency e o script é dispensável: adicione `pacote: false` em `allowBuilds`. `true` só com justificativa |
   | `blockExoticSubdeps` | transitiva de git ou de tarball | não contorne; escolha outro pacote |
5. Rode `pnpm verify` e `pnpm audit signatures`.
6. O lockfile só muda pelo pnpm. Edição manual é negada pelo hook do agente e não passa no
   `--frozen-lockfile`.

## Hotfix de segurança fora da quarentena

Quando uma correção de vulnerabilidade crítica (por exemplo, do Next.js) foi publicada há menos
de 3 dias:

1. Confirme o advisory na fonte primária (GitHub Advisory, advisory do projeto) e a versão
   corrigida.
2. O Renovate abre o PR de vulnerabilidade sem esperar a quarentena e inclui a versão em
   `minimumReleaseAgeExclude`. Se não abrir, adicione a entrada à mão **só para aquela
   versão**, com comentário que cite o advisory.
3. Revise o diff do lockfile: só o pacote esperado mudou?
4. Faça o merge e o deploy. Meta: patch crítico em até 7 dias (ASVS 15.1.1) e Next.js em até
   48 h.
5. O `minimumReleaseAgeExcludePrune` remove a exceção quando ela deixa de ser usada. Confira no
   PR seguinte.

## Advisory sem correção

1. Avalie se o código vulnerável é alcançável a partir de entrada de usuário em produção.
2. Se não for, adicione o GHSA em `audit.ignore` com comentário: pacote, caminho, por que não é
   explorável e quando revisar. O `ignorePrune` remove a entrada quando o pacote sai da árvore.
3. Se for, contenha o risco (validação, desligar a feature, trocar a dependência) e trate como
   incidente ([resposta a incidentes](resposta-a-incidentes.md), playbook P3).

Exceções em vigor: `GHSA-vfj7-8cjw-p6xm` (braces via `@next/eslint-plugin-next`, só lint) e
`GHSA-67mh-4wv8-2f99` (servidor de dev do esbuild via drizzle-kit, que só usa a API de
transform).

## Actions e imagens

- Nova action: só de publicador da allowlist da organização, pinada pelo **SHA do commit**
  (para tag anotada, o `^{}` do `git ls-remote`), com comentário `# vX.Y.Z` e com pelo menos 7
  dias de publicação.
- Imagem: `nome:tag@sha256:<digest>`.
- Nenhuma action com `version: latest` interna: passe a versão explicitamente.
- Job com segredo ou `id-token`: `cache-mode: none` e sem `pnpm install` no mesmo job do
  deploy.
- Evite actions de terceiros abandonadas. A tabela de "abandonadas e com pegadinha" da pesquisa
  incluiu `tj-actions/changed-files`, `semgrep-action`, `gitleaks-action` v2 (node20) e
  `claude-code-security-review`.

## Revisões periódicas

| Frequência | O quê |
|---|---|
| Semanal | Dependency Dashboard do Renovate; varredura agendada do `security.yml` |
| Mensal | advisories de Next.js, Better Auth, Drizzle e `pg`; SHAs vendorizados em `scripts/vendor-claude-skills.sh` |
| A cada release | pendências conhecidas (abaixo) |

Pendências conhecidas (17/10/2026):

- Versões que ficaram atrás por causa da quarentena: Next 16.4.2, React 19.3.1, Vitest 5.0.5,
  ESLint 10.13.0, Turborepo 2.11.9, Playwright 1.64.1, `@axe-core/playwright` 4.14.0. O
  Renovate abre os PRs quando passarem da quarentena.
- lefthook 2.2.2 foi barrado pelo `trustPolicy` (publicado sem provenance). Revisar quando sair
  uma release com provenance.
- Suporte oficial da Vercel ao pnpm 11: não documentado. Testar no primeiro deploy.

## Configuração do GitHub (fora do repositório)

Lista completa em [.github/rulesets/README.md](../../.github/rulesets/README.md):

- ruleset com commits assinados e os checks `ci-ok` e `security-ok`;
- allowlist de actions e pin obrigatório por SHA;
- token de workflow só leitura;
- aprovação de workflows para contribuidor externo;
- Dependabot alerts ligados e updates desligados;
- secret scanning e push protection;
- private vulnerability reporting.

## Referências

- Incidentes:
  - TanStack, postmortem primário:
    https://github.com/TanStack/tanstack.com/blob/main/src/blog/npm-supply-chain-compromise-postmortem.md
  - tj-actions (CVE-2025-30066): https://github.com/advisories?query=CVE-2025-30066
  - Shai-Hulud 2.0 (secundária): https://securelist.com/shai-hulud-2-0/118214/
  - axios (secundária): https://www.endorlabs.com/learn/npm-axios-compromise
- pnpm, supply chain: https://github.com/pnpm/pnpm.io/blob/main/docs/supply-chain-security.md
- Renovate: https://docs.renovatebot.com/
- OpenSSF Scorecard: https://github.com/ossf/scorecard
