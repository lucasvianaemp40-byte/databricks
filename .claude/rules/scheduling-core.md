---
paths:
  - "packages/scheduling-core/**"
---

# Domínio puro (@salon/scheduling-core)

- Sem I/O, sem framework, sem relógio global, sem aleatoriedade: o lint proíbe `Date.now`,
  `new Date(...)`, `Temporal.Now`, `Math.random`, `toLocale*String`.
- "Agora" entra por `Clock` (`systemClock` em produção, `fixedClock(...)` em teste), lido UMA
  vez por operação.
- Tempo com Temporal (`import { Temporal } from 'temporal-polyfill'`): instantes em
  `Temporal.Instant`, intervalos semiabertos `[início, fim)`, fuso IANA da unidade (nunca o do
  servidor/navegador, nunca offset fixo). Siga as regras de horário ambíguo/inexistente do
  README do pacote.
- Entrada inválida lança `SchedulingInputError` com o campo ofensor.
- TDD: teste de exemplo + propriedade (fast-check, arbitrários em `test/arbitraries/`).
  Mudou a máquina de estados? O trigger do banco precisa mudar junto (teste de paridade).
