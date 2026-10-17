---
name: qa
description: Fluxo de QA do Agenda Salão, que transforma critérios de aceite em testes (unitário, propriedade, integração com RLS, E2E), explora a aplicação pelo MCP do Playwright e converte cada achado em spec que falha. Use quando pedirem QA, testes de aceitação ou exploração de uma feature/fluxo.
argument-hint: "<feature, fluxo ou critérios de aceite>"
---

# qa

Alvo: $ARGUMENTS

1. **Critérios de aceite.** Extraia da issue, do pedido ou de `docs/produto/` os critérios no
   formato Dado/Quando/Então, incluindo os negativos (outro tenant, papel sem permissão,
   horário fora da jornada, antecedência mínima, fuso diferente, corrida de reserva).
   Pergunte ao usuário só se um critério essencial estiver ambíguo.
2. **Mapa de testes.** Para cada critério, escolha a camada mais barata que o prova:
   `@salon/scheduling-core` (regra pura, fast-check) -> `@salon/db` (`pnpm test:db`, RLS e
   constraints) -> `apps/web` unit -> E2E (`apps/web/e2e/*.spec.ts`, Playwright + axe).
3. **Escrita dos testes.** Delegue ao subagente `qa-engineer` (ferramenta Agent) com os
   critérios e o mapa. Testes novos de comportamento ainda não implementado devem FALHAR.
4. **Exploração.** Suba o app (`pnpm --filter @salon/web dev`, porta 3000, em background) e use
   as ferramentas `mcp__playwright__*`: navegue no fluxo em viewport mobile e desktop, tente
   entradas inválidas, voltar/recarregar, duplo clique em "confirmar", outro fuso. Não use
   credenciais reais nem sites externos.
5. **Achado vira spec.** Cada comportamento errado vira um `e2e/<tema>.spec.ts` (ou teste na
   camada mais baixa que reproduz) que falha pelo motivo certo. Não corrija produção aqui.
6. **Relatório.** Critério -> teste (arquivo) -> resultado; achados com o teste que falha;
   o que não foi explorado e por quê.
