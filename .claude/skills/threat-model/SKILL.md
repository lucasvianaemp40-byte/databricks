---
name: threat-model
description: Gera o threat model (STRIDE + LINDDUN) de uma feature ANTES de implementar e grava em docs/seguranca/threat-models/. Use quando pedirem modelagem de ameaças ou pela skill new-feature em feature que toque dados pessoais, pagamento, autenticação, papéis, página pública, integrações ou jobs.
argument-hint: "<feature, issue ou descrição>"
context: fork
agent: threat-modeler
background: false
---

Feature a modelar: $ARGUMENTS

Leia o código e a documentação relevantes (`CLAUDE.md`, `docs/`, `packages/db/README.md`,
`apps/web/README.md`) antes de modelar. Grave o arquivo e responda com o caminho e as três
mitigações mais urgentes, cada uma com o teste que a prova.
