# Documentação do Agenda Salão

Documentação viva do produto: muda no mesmo PR que muda o comportamento. As decisões ficam em
ADRs. O que é interpretação legal está marcado **"a validar com jurídico"** e não substitui
parecer de advogado.

Data de referência das pesquisas que embasam estes textos: **16 e 17/10/2026**. Versões,
preços e normas mudam: confira a fonte citada antes de usar um número em contrato, preço ou
código.

## Mapa

| Área | Documento | Para quê |
|---|---|---|
| Visão geral | [arquitetura.md](arquitetura.md) | Contexto e contêineres (C4 níveis 1 e 2), fronteiras de confiança, fluxo de agendamento, multi-tenancy em profundidade, tempo, jobs, hospedagem e observabilidade |
| Decisões | [adr/README.md](adr/README.md) | Índice dos ADRs e [modelo](adr/0000-modelo.md) |
| Segurança | [seguranca/README.md](seguranca/README.md) | Índice da área de segurança |
| | [seguranca/modelo-de-ameacas.md](seguranca/modelo-de-ameacas.md) | STRIDE por componente, LINDDUN resumido e casos de abuso do agendamento |
| | [seguranca/asvs-l2.md](seguranca/asvs-l2.md) | Checklist OWASP ASVS 5.0 nível 2 com status e desvios aceitos |
| | [seguranca/headers-e-csp.md](seguranca/headers-e-csp.md) | CSP por nonce, cabeçalhos, CSRF e cookies |
| | [seguranca/resposta-a-incidentes.md](seguranca/resposta-a-incidentes.md) | Runbook, prazos da ANPD e playbooks |
| | [seguranca/supply-chain.md](seguranca/supply-chain.md) | Dependências, quarentena, pins, Renovate e procedimentos |
| | [seguranca/threat-models/](seguranca/threat-models/README.md) | Threat models por feature (gerados pela skill `threat-model`) |
| | [seguranca/auditorias/](seguranca/auditorias/README.md) | Relatórios de auditoria (skills `appsec-audit` e `tob-differential-review`) |
| LGPD | [lgpd/README.md](lgpd/README.md) | Índice, glossário e base normativa |
| | [lgpd/papeis-e-bases-legais.md](lgpd/papeis-e-bases-legais.md) | Controlador, operador e base legal por categoria de dado |
| | [lgpd/inventario-de-dados.md](lgpd/inventario-de-dados.md) | Dados pessoais por tabela do MVP |
| | [lgpd/direitos-do-titular.md](lgpd/direitos-do-titular.md) | Requisitos de engenharia para o art. 18 |
| | [lgpd/retencao.md](lgpd/retencao.md) | Prazos de retenção e eliminação |
| | [lgpd/dados-sensiveis.md](lgpd/dados-sensiveis.md) | Anamnese, ficha técnica e fotos |
| | [lgpd/checklist-contratual.md](lgpd/checklist-contratual.md) | DPA, termos, política de privacidade e suboperadores |
| Domínio | [dominio/glossario.md](dominio/glossario.md) | Termos em pt-BR e os identificadores em inglês do código |
| | [dominio/modelo.md](dominio/modelo.md) | Entidades, invariantes, máquina de estados, disponibilidade, concorrência e holds de Pix |
| | [dominio/integracoes.md](dominio/integracoes.md) | WhatsApp Cloud API, Pix, NFS-e nacional, Lei do Salão-Parceiro, Google Calendar |
| Produto | [produto/concorrentes-e-posicionamento.md](produto/concorrentes-e-posicionamento.md) | Mercado, dores e diferenciais |
| | [produto/mvp-e-roadmap.md](produto/mvp-e-roadmap.md) | MVP, fases 2 e 3, métricas |
| | [produto/backlog-inicial.md](produto/backlog-inicial.md) | Épicos e histórias priorizadas |
| QA | [qa/estrategia.md](qa/estrategia.md) | Troféu de testes, convenções, gates, flaky, cobertura, RLS, E2E, DAST |
| | [qa/criterios-de-aceite.md](qa/criterios-de-aceite.md) | Checklist por história |
| Desenvolvimento | [desenvolvimento/fluxo-com-claude.md](desenvolvimento/fluxo-com-claude.md) | Uso do kit Claude Code: skills, agentes, hooks e plugins |

Documentos fora de `docs/` que completam este índice:

- [README da raiz](../README.md): quickstart e comandos.
- [CLAUDE.md](../CLAUDE.md): regras inegociáveis e Definition of Done.
- [SECURITY.md](../SECURITY.md): como relatar vulnerabilidades.
- READMEs dos pacotes: [apps/web](../apps/web/README.md),
  [packages/scheduling-core](../packages/scheduling-core/README.md) e
  [packages/db](../packages/db/README.md). Esses READMEs são a fonte de verdade do que está
  implementado. Os documentos daqui explicam o porquê e o que vem depois.
- [.claude/README.md](../.claude/README.md): o kit do Claude Code em detalhe.
- [.github/rulesets/README.md](../.github/rulesets/README.md): configuração do GitHub que não
  fica em arquivo.

## Convenções

- **Idioma:** documentação em pt-BR. Identificadores de código citados como estão no código
  (em inglês), entre crases.
- **Status de implementação:** os documentos marcam explicitamente o que está
  **implementado na fundação**, o que é **planejado** e o que é **proposta**. Não descreva
  como existente o que ainda não está no código.
- **Fontes:** cite a fonte primária (lei, norma, documentação oficial, repositório no commit
  ou tag). Quando só houver fonte secundária, diga isso. Quando algo não pôde ser verificado,
  escreva "não verificado".
- **Diagramas:** Mermaid, que o GitHub renderiza.
- **Mudou a arquitetura?** Escreva um ADR novo. ADR aceito não se reescreve: substitua-o por
  outro e marque o antigo como "Substituído por ADR-NNNN".
- **Threat model** antes de feature que toque dado pessoal, pagamento, autenticação ou página
  pública (skill `threat-model`).
