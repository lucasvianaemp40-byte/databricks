# Threat models por feature

Threat model curto e versionado, feito **antes** de implementar uma feature que toque dado
pessoal, pagamento (Pix), autenticação, papéis, página pública, integrações (WhatsApp, e-mail,
webhooks), arquivos ou jobs. O modelo geral do sistema está em
[../modelo-de-ameacas.md](../modelo-de-ameacas.md).

## Índice

| Data | Feature | Arquivo | Situação |
|---|---|---|---|
| 2026-10-20 | Login, cadastro e onboarding do salão (E1.1, E1.3, E1.9/E1.10 parcial, E2.1) | [2026-10-20-login-cadastro-onboarding.md](2026-10-20-login-cadastro-onboarding.md) | v1, antes da implementação; LC-06 a decidir (bloqueia produção) |

Threat model novo entra nesta tabela no mesmo PR.

## Como gerar

No Claude Code, rode a skill `threat-model` com a descrição da feature. Ela usa o agente
`threat-modeler` e grava o arquivo aqui. A skill `new-feature` a chama quando a feature se
encaixa nos critérios acima. Também dá para escrever à mão seguindo o formato abaixo.

## Nome do arquivo

`AAAA-MM-DD-<slug>.md`, por exemplo `2026-11-03-pagina-publica-de-agendamento.md`.

## Formato

1. **Contexto:** a feature, os ativos (PII, agenda, pagamentos, tokens), os atores e os fluxos.
2. **Diagrama:** Mermaid `flowchart LR` com as fronteiras de confiança.
3. **Tabela de ameaças:**

   | ID | STRIDE ou LINDDUN | Cenário | Risco (A/M/B) | Mitigação | Teste que prova | Status |
   |---|---|---|---|---|---|---|

   Sempre avalie: isolamento entre tenants, abuso da página pública (enumeração, flood de
   reservas, holds), replay de webhook, corrida de reserva, PII em logs e erros, e fail-open.
4. **Requisitos ASVS 5.0 L2** aplicáveis, por capítulo.
5. **Suposições**, **riscos aceitos** (com dono) e **perguntas em aberto** (inclusive o que
   vai para o jurídico).

Regra: não invente controle que não existe. Marque "a implementar" e ligue ao teste que vai
provar a mitigação. Ameaça mitigada sem teste conta como aberta.
