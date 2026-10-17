# Avisos de terceiros (THIRD_PARTY_NOTICES)

Arquivos de terceiros incluídos em `.claude/` por `scripts/vendor-claude-skills.sh`. Cada
arquivo foi obtido de um commit fixo, lido integralmente antes de entrar no repositório e
adaptado como descrito abaixo. Cada SKILL.md e cada agente vendorizado traz, logo após o
frontmatter, uma linha de procedência. Gerado automaticamente: não edite à mão; rode o script.

O código da aplicação (apps/, packages/) não deriva destes materiais: as licenças abaixo
valem só para os arquivos listados.

## Trail of Bits

- Origem: https://github.com/trailofbits/skills (commit `5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0`)
- Licença: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); cópia em `.claude/licenses/trailofbits-skills-CC-BY-SA-4.0.txt`.
- Atribuição: material de Trail of Bits, sob CC BY-SA 4.0. Os arquivos adaptados abaixo
  permanecem sob CC BY-SA 4.0 (compartilha-igual); as mudanças estão indicadas por arquivo.

| Arquivo | Origem | Alterações |
| --- | --- | --- |
| `.claude/skills/tob-fp-check/SKILL.md` | `plugins/fp-check/skills/fp-check/SKILL.md` | nome com prefixo; allowed-tools sem Bash/Write/Edit/Task amplos; {baseDir} -> ${CLAUDE_SKILL_DIR}; nota local |
| `.claude/skills/tob-fp-check/references/bug-class-verification.md` | `plugins/fp-check/skills/fp-check/references/bug-class-verification.md` | links relativos no lugar de {baseDir} |
| `.claude/skills/tob-fp-check/references/evidence-templates.md` | `plugins/fp-check/skills/fp-check/references/evidence-templates.md` | links relativos no lugar de {baseDir} |
| `.claude/skills/tob-fp-check/references/false-positive-patterns.md` | `plugins/fp-check/skills/fp-check/references/false-positive-patterns.md` | links relativos no lugar de {baseDir} |
| `.claude/skills/tob-fp-check/references/gate-reviews.md` | `plugins/fp-check/skills/fp-check/references/gate-reviews.md` | links relativos no lugar de {baseDir} |
| `.claude/skills/tob-fp-check/references/standard-verification.md` | `plugins/fp-check/skills/fp-check/references/standard-verification.md` | links relativos no lugar de {baseDir} |
| `.claude/skills/tob-fp-check/references/deep-verification.md` | `plugins/fp-check/skills/fp-check/references/deep-verification.md` | links relativos; nomes dos agentes com prefixo tob- |
| `.claude/agents/tob-data-flow-analyzer.md` | `plugins/fp-check/agents/data-flow-analyzer.md` | nome com prefixo tob-; referências à skill tob-fp-check |
| `.claude/agents/tob-exploitability-verifier.md` | `plugins/fp-check/agents/exploitability-verifier.md` | nome com prefixo tob-; referências à skill tob-fp-check |
| `.claude/agents/tob-poc-builder.md` | `plugins/fp-check/agents/poc-builder.md` | nome com prefixo tob-; referências à skill tob-fp-check |
| `.claude/skills/tob-differential-review/SKILL.md` | `plugins/differential-review/skills/differential-review/SKILL.md` | nome com prefixo; allowed-tools sem Bash/Write amplos; agente tob-adversarial-modeler; nota local |
| `.claude/skills/tob-differential-review/methodology.md` | `plugins/differential-review/skills/differential-review/methodology.md` | baseline lida com git show em vez de git checkout |
| `.claude/skills/tob-differential-review/adversarial.md` | `plugins/differential-review/skills/differential-review/adversarial.md` | sem alterações |
| `.claude/skills/tob-differential-review/patterns.md` | `plugins/differential-review/skills/differential-review/patterns.md` | sem alterações |
| `.claude/skills/tob-differential-review/reporting.md` | `plugins/differential-review/skills/differential-review/reporting.md` | local do relatório dentro do repositório; sem fallback para Desktop/home; sem issue-writer |
| `.claude/agents/tob-adversarial-modeler.md` | `plugins/differential-review/agents/adversarial-modeler.md` | nome com prefixo; caminhos das referências |
| `.claude/skills/tob-property-based-testing/SKILL.md` | `plugins/property-based-testing/skills/property-based-testing/SKILL.md` | nome com prefixo; nota local |
| `.claude/skills/tob-property-based-testing/references/generating.md` | `plugins/property-based-testing/skills/property-based-testing/references/generating.md` | sem alterações |
| `.claude/skills/tob-property-based-testing/references/interpreting-failures.md` | `plugins/property-based-testing/skills/property-based-testing/references/interpreting-failures.md` | sem alterações |
| `.claude/skills/tob-property-based-testing/references/libraries.md` | `plugins/property-based-testing/skills/property-based-testing/references/libraries.md` | sem alterações |
| `.claude/skills/tob-property-based-testing/references/refactoring.md` | `plugins/property-based-testing/skills/property-based-testing/references/refactoring.md` | sem alterações |
| `.claude/skills/tob-property-based-testing/references/reviewing.md` | `plugins/property-based-testing/skills/property-based-testing/references/reviewing.md` | sem alterações |
| `.claude/skills/tob-sharp-edges/SKILL.md` | `plugins/sharp-edges/skills/sharp-edges/SKILL.md` | nome com prefixo; só a referência de JavaScript/TypeScript (as de outras linguagens e case-studies não foram vendorizadas) |
| `.claude/skills/tob-sharp-edges/references/auth-patterns.md` | `plugins/sharp-edges/skills/sharp-edges/references/auth-patterns.md` | sem alterações |
| `.claude/skills/tob-sharp-edges/references/config-patterns.md` | `plugins/sharp-edges/skills/sharp-edges/references/config-patterns.md` | sem alterações |
| `.claude/skills/tob-sharp-edges/references/crypto-apis.md` | `plugins/sharp-edges/skills/sharp-edges/references/crypto-apis.md` | sem alterações |
| `.claude/skills/tob-sharp-edges/references/lang-javascript.md` | `plugins/sharp-edges/skills/sharp-edges/references/lang-javascript.md` | sem alterações |
| `.claude/agents/tob-sharp-edges-analyzer.md` | `plugins/sharp-edges/agents/sharp-edges-analyzer.md` | nome com prefixo; lista de referências reduzida às vendorizadas |

## Functional Software, Inc. (Sentry)

- Origem: https://github.com/getsentry/skills (commit `f57ada2d0b640406ea7e25b11d636c530e77c58b`)
- Licença: Apache-2.0 (referências derivadas do OWASP Cheat Sheet Series: CC BY-SA 4.0) (https://www.apache.org/licenses/LICENSE-2.0); cópia em `.claude/licenses/getsentry-skills-Apache-2.0.txt`.
- Aviso adicional da origem: `.claude/licenses/getsentry-security-review-OWASP-CC-BY-SA-4.0.txt`.
- Arquivos modificados em relação à origem estão indicados abaixo (Apache-2.0, seção 4(b)).

| Arquivo | Origem | Alterações |
| --- | --- | --- |
| `.claude/skills/sentry-security-review/SKILL.md` | `skills/security-review/SKILL.md` | renomeada (não substitui o /security-review embutido); allowed-tools sem Bash/Task amplos; campo license; nota local |
| `.claude/skills/sentry-security-review/languages/javascript.md` | `skills/security-review/languages/javascript.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/api-security.md` | `skills/security-review/references/api-security.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/authentication.md` | `skills/security-review/references/authentication.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/authorization.md` | `skills/security-review/references/authorization.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/business-logic.md` | `skills/security-review/references/business-logic.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/csrf.md` | `skills/security-review/references/csrf.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/data-protection.md` | `skills/security-review/references/data-protection.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/error-handling.md` | `skills/security-review/references/error-handling.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/injection.md` | `skills/security-review/references/injection.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/logging.md` | `skills/security-review/references/logging.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/misconfiguration.md` | `skills/security-review/references/misconfiguration.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/ssrf.md` | `skills/security-review/references/ssrf.md` | sem alterações |
| `.claude/skills/sentry-security-review/references/xss.md` | `skills/security-review/references/xss.md` | sem alterações |

## Anthropic, PBC (plugin pr-review-toolkit)

- Origem: https://github.com/anthropics/claude-plugins-official (commit `ea10b213686c90bb1984b2016937310e05336cf3`)
- Licença: Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0); cópia em `.claude/licenses/anthropic-pr-review-toolkit-Apache-2.0.txt`.
- Arquivos modificados em relação à origem estão indicados abaixo (Apache-2.0, seção 4(b)).

| Arquivo | Origem | Alterações |
| --- | --- | --- |
| `.claude/agents/anthropic-silent-failure-hunter.md` | `plugins/pr-review-toolkit/agents/silent-failure-hunter.md` | nome com prefixo; description reescrita (o original não era YAML válido); tools mínimas; convenções internas do Claude Code (errorIds, Statsig) trocadas pelas do projeto |
| `.claude/agents/anthropic-pr-test-analyzer.md` | `plugins/pr-review-toolkit/agents/pr-test-analyzer.md` | nome com prefixo; tools mínimas |
| `.claude/agents/anthropic-type-design-analyzer.md` | `plugins/pr-review-toolkit/agents/type-design-analyzer.md` | nome com prefixo; tools mínimas |

## Jesse Vincent (Copyright (c) 2025 Jesse Vincent)

- Origem: https://github.com/obra/superpowers (commit `bb92a77741419a4ab5f06e711a283343f1ada0c3`)
- Licença: MIT (https://opensource.org/license/mit); cópia em `.claude/licenses/obra-superpowers-MIT.txt`.
- Aviso de copyright e de permissão preservados na cópia da licença.

| Arquivo | Origem | Alterações |
| --- | --- | --- |
| `.claude/skills/superpowers-test-driven-development/SKILL.md` | `skills/test-driven-development/SKILL.md` | nome com prefixo; nota local |
| `.claude/skills/superpowers-test-driven-development/writing-good-tests.md` | `skills/test-driven-development/writing-good-tests.md` | referência a skill não vendorizada |
| `.claude/skills/superpowers-systematic-debugging/SKILL.md` | `skills/systematic-debugging/SKILL.md` | nome com prefixo; referências às skills vendorizadas |
| `.claude/skills/superpowers-systematic-debugging/root-cause-tracing.md` | `skills/systematic-debugging/root-cause-tracing.md` | script find-polluter.sh não vendorizado; instrução equivalente com vitest |
| `.claude/skills/superpowers-systematic-debugging/defense-in-depth.md` | `skills/systematic-debugging/defense-in-depth.md` | sem alterações |
| `.claude/skills/superpowers-systematic-debugging/condition-based-waiting.md` | `skills/systematic-debugging/condition-based-waiting.md` | exemplo .ts não vendorizado; equivalentes do Playwright/Vitest |
| `.claude/skills/superpowers-verification-before-completion/SKILL.md` | `skills/verification-before-completion/SKILL.md` | nome com prefixo; nota local |

## Microsoft Corporation

- Origem: https://github.com/microsoft/playwright-cli (commit `b85c7a736bb473bf55b584e54a09ffa698d6d871`)
- Licença: Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0); cópia em `.claude/licenses/microsoft-playwright-cli-Apache-2.0.txt`.
- Arquivos modificados em relação à origem estão indicados abaixo (Apache-2.0, seção 4(b)).

| Arquivo | Origem | Alterações |
| --- | --- | --- |
| `.claude/skills/ms-playwright-cli/SKILL.md` | `skills/playwright-cli/SKILL.md` | nome com prefixo; comando local em vez do binário global; seção de instalação substituída (sem npm -g/npx, sem attach ao navegador pessoal); allowed-tools restrito; referências não vendorizadas removidas |
| `.claude/skills/ms-playwright-cli/references/element-attributes.md` | `skills/playwright-cli/references/element-attributes.md` | comando local nos blocos de código |
| `.claude/skills/ms-playwright-cli/references/request-mocking.md` | `skills/playwright-cli/references/request-mocking.md` | comando local nos blocos de código |
| `.claude/skills/ms-playwright-cli/references/storage-state.md` | `skills/playwright-cli/references/storage-state.md` | comando local nos blocos de código |
| `.claude/skills/ms-playwright-cli/references/playwright-tests.md` | `skills/playwright-cli/references/playwright-tests.md` | comando local (pnpm) no lugar de npx |
| `.claude/skills/ms-playwright-cli/references/test-generation.md` | `skills/playwright-cli/references/test-generation.md` | comando local (pnpm); sem bootstrap via npm init; referência não vendorizada removida |

## Não vendorizados (avaliados e recusados)

- `claude-security` (claude-plugins-official): licença proprietária, proíbe redistribuição. Use como plugin local.
- Skills de documentos do `anthropics/skills` (docx, pdf, pptx, xlsx): "source-available", todos os direitos reservados.
- `trailofbits/claude-code-config`: repositório sem licença.
- Semgrep Guardian (`semgrep/mcp-marketplace`): sem licença e com binários pré-compilados.
- `getsentry/skills` skill-scanner: depende de um script Python não revisado para execução.
- Demais referências da skill security-review da Sentry (cryptography, deserialization, file-security, modern-threats, supply-chain, python, docker), das referências de outras linguagens e `case-studies` do sharp-edges, e `agentic-actions-auditor`/`gha-security-review`: fora do escopo atual; disponíveis pelos plugins `trailofbits` e `sentry-skills` no CLI local.
- Scripts e exemplos executáveis de qualquer origem (ex.: `find-polluter.sh`, `condition-based-waiting-example.ts`).

