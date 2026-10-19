---
name: review-migration
description: Revisa migrações PostgreSQL novas ou alteradas do @salon/db (RLS por tenant, imutabilidade, locks na transação única do runner, integridade, EXCLUDE anti-dupla-reserva). Use sempre que criar migração ou alterar o schema do banco, antes do commit.
argument-hint: "[arquivos de migração]"
context: fork
agent: migration-reviewer
background: false
---

Revise as migrações: $ARGUMENTS

Sem arquivos informados, revise as migrações novas ou alteradas em relação à branch padrão
(`git diff --name-only --merge-base origin/HEAD -- packages/db` mais o working tree). Responda
com o veredito, os achados e os testes de RLS/constraint que precisam existir.
