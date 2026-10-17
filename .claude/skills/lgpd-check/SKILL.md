---
name: lgpd-check
description: Revisão técnica de privacidade/LGPD de um escopo (diff, módulo, schema, integração ou texto de consentimento). Use quando pedirem revisão de LGPD/privacidade, ou pela skill pre-pr quando o diff tocar dado pessoal, anamnese, logs, analytics ou integrações de mensagem/pagamento.
argument-hint: "[escopo]"
context: fork
agent: lgpd-privacy-reviewer
background: false
---

Revise sob a ótica da LGPD o escopo: $ARGUMENTS

Sem escopo, revise as mudanças da branch (`git diff --merge-base origin/HEAD`), priorizando
schema e migrações de `packages/db`, dados de cliente, logs, analytics e integrações.
