---
name: new-feature
description: Fluxo completo para implementar uma feature no Agenda Salão - entender, threat model rápido, plano, TDD, verify, revisão de segurança e PR. Use quando o usuário pedir uma funcionalidade nova ou mudança de comportamento de produto (não para correções triviais).
argument-hint: "<descrição da feature ou link da issue>"
---

# new-feature

Feature: $ARGUMENTS

## 1. Entender
- Leia o pedido, `CLAUDE.md`, a documentação de domínio (`docs/dominio/`, `docs/produto/`) e o
  código que será tocado. Liste atores, regras de negócio, dados pessoais envolvidos e
  critérios de aceite (Dado/Quando/Então, inclusive negativos).
- Pergunte só o que bloqueia (regra de negócio ambígua, decisão de produto).

## 2. Threat model rápido
- Toca dado pessoal, pagamento, autenticação, papéis, página pública, integração ou job? Use a
  skill `threat-model`. Senão, registre em 3 linhas no plano por que o risco é baixo.

## 3. Plano
- Pacotes afetados, ordem (core -> db -> web), migrações (forward-only), testes por camada,
  riscos e o que fica fora. Mudança de arquitetura vira ADR em `docs/adr/`.

## 4. TDD
- Para cada critério: teste que falha -> implementação mínima -> refatoração. Regra de agenda
  nasce no `@salon/scheduling-core` (puro, `Clock` injetado, Temporal); acesso a dados via
  `withTenant`; entrada validada com zod; autorização no servidor.
- Migração: `pnpm --filter @salon/db generate` / `generate:custom`, depois a skill
  `review-migration`. Nunca edite migração publicada.

## 5. Verificar
- Skill `verify` (inclui `pnpm test:db` e `pnpm e2e` quando aplicável).

## 6. Revisão de segurança
- Skill `pre-pr`: `appsec-reviewer` no diff, `pentest-tenant` se tocar autorização/dados,
  `lgpd-check` se tocar dado pessoal.

## 7. PR
- Siga a skill `steward` (commits convencionais em pt-BR, descrição com riscos e testes).
