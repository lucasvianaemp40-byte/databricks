# Registros de decisão de arquitetura (ADRs)

Um ADR registra uma decisão que muda a estrutura, a stack, a segurança ou a operação do
produto: o contexto, a decisão, as consequências e as alternativas descartadas. O formato
segue a proposta de Michael Nygard
([Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)).

## Índice

| ADR | Título | Status |
|---|---|---|
| [0001](0001-monorepo-e-stack.md) | Monorepo pnpm + Turborepo e stack com versões | Aceito |
| [0002](0002-isolamento-multi-tenant-rls.md) | Isolamento multi-tenant com PostgreSQL RLS | Aceito |
| [0003](0003-tempo-e-fusos-temporal.md) | Tempo e fusos com Temporal e fuso IANA por unidade | Aceito |
| [0004](0004-autenticacao-better-auth.md) | Autenticação com Better Auth (organizações, 2FA, passkeys) | Proposto (próxima iteração) |
| [0005](0005-fila-pg-boss.md) | Fila de jobs com pg-boss no próprio PostgreSQL | Proposto |
| [0006](0006-hospedagem-e-residencia.md) | Hospedagem e residência de dados no Brasil | Proposto |
| [0007](0007-politica-de-supply-chain.md) | Política de cadeia de suprimentos | Aceito |
| [0008](0008-desenvolvimento-assistido-por-ia.md) | Desenvolvimento assistido por IA (kit Claude Code) | Aceito (decisão 3 substituída pelo ADR-0011) |
| [0009](0009-lint-biome-eslint.md) | Lint e formatação: Biome + ESLint enxuto | Aceito |
| [0010](0010-observabilidade.md) | Observabilidade: logs, erros e eventos de segurança | Proposto (iteração 1, T2) |
| [0011](0011-plugins-e-mcp-na-nuvem.md) | Plugins e MCP do Playwright nas sessões na nuvem | Aceito |

## Como escrever um ADR

1. Copie o [modelo](0000-modelo.md) para `NNNN-titulo-curto.md`, usando o próximo número livre.
2. Status inicial **Proposto**. Ele vira **Aceito** quando o PR que o introduz é aprovado e a
   implementação começa.
3. ADR aceito não é reescrito. Para mudar a decisão, escreva um ADR novo e marque o antigo
   como **Substituído por ADR-NNNN**. Correções de fato (link quebrado, versão de patch) são
   permitidas e devem ficar registradas no histórico do Git.
4. Cite fontes primárias e diga o que não foi verificado.
5. Escreva um ADR quando a decisão for cara de reverter: banco, autenticação, hospedagem,
   formato de dados, fronteira de segurança, dependência estrutural.

Status possíveis: Proposto, Aceito, Rejeitado, Obsoleto, Substituído por ADR-NNNN.
