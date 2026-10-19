# LGPD

> **Aviso:** estes documentos são interpretação técnica de engenharia para orientar o produto.
> **Não são parecer jurídico.** Todo enquadramento legal (papéis, bases, prazos, cláusulas) está
> **a validar com jurídico** antes de virar contrato, política de privacidade ou texto de tela.

| Documento | Conteúdo |
|---|---|
| [papeis-e-bases-legais.md](papeis-e-bases-legais.md) | Controlador e operador no modelo B2B2C; base legal por categoria de dado; encarregado |
| [inventario-de-dados.md](inventario-de-dados.md) | Dados pessoais por tabela do MVP: finalidade, base, retenção e proteção |
| [direitos-do-titular.md](direitos-do-titular.md) | Requisitos de engenharia para os direitos do art. 18 |
| [retencao.md](retencao.md) | Prazos de retenção e mecanismos de eliminação |
| [dados-sensiveis.md](dados-sensiveis.md) | Anamnese, ficha técnica e fotos: base legal, criptografia, acesso, RIPD |
| [checklist-contratual.md](checklist-contratual.md) | DPA com salões, termos, política de privacidade, suboperadores e transferência internacional |

Incidentes com dados pessoais: [resposta a incidentes](../seguranca/resposta-a-incidentes.md).

## Glossário rápido

| Termo | Significado (LGPD, art. 5º) |
|---|---|
| Titular | pessoa natural a quem os dados se referem: cliente final, profissional, dono |
| Controlador | quem decide sobre o tratamento. Aqui, em regra, o **salão** para os dados dos clientes dele |
| Operador | quem trata em nome do controlador. Aqui, a **plataforma** para os dados dos clientes dos salões |
| Encarregado | canal entre controlador, titulares e ANPD. Indicado pelo controlador **e pelo operador** (art. 5º, VIII) |
| Dado sensível | inclui dado referente à saúde e dado biométrico (art. 5º, II): anamnese é dado de saúde |
| ANPD | Agência Nacional de Proteção de Dados |

## Base normativa e grau de verificação

O site do Planalto e o gov.br estavam bloqueados na pesquisa (16 e 17/10/2026). O texto da LGPD
foi lido em cópia não oficial, e as resoluções em fontes secundárias (escritórios de
advocacia). **Confira no texto oficial antes de citar.**

| Norma | Ponto usado aqui | Verificação |
|---|---|---|
| [Lei 13.709/2018 (LGPD)](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm) | arts. 5º, 6º, 7º, 8º, 11, 14, 16, 18, 19, 33, 37, 38, 39, 41, 42, 46, 48 e 52 | cópia não oficial |
| [Lei 12.965/2014 (Marco Civil)](https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2014/lei/l12965.htm), art. 15 | guarda de registros de acesso a aplicações por 6 meses | cópia não oficial |
| Res. CD/ANPD nº 2/2022 | agente de pequeno porte (prazos em dobro; não vale para alto risco) | secundária |
| Res. CD/ANPD nº 15/2024 | incidentes: 3 dias úteis; complementação em 20 dias úteis; registro por 5 anos | secundária |
| Res. CD/ANPD nº 18/2024 | encarregado: designação formal, substituto, sem conflito de interesse | secundária |
| Res. CD/ANPD nº 19/2024 | transferência internacional: cláusulas-padrão obrigatórias desde 23/08/2025 | secundária |
| Res. CD/ANPD nº 32/2026 | adequação recíproca Brasil–União Europeia | secundária |
| Lei 15.211/2025 (ECA Digital) | produtos de acesso provável por crianças e adolescentes; vigente desde 17/03/2026 | secundária |
| Lei 15.352/2026 | ANPD passa a agência reguladora | secundária |

## Princípios aplicados no produto

- **Minimização** (art. 6º, III): o agendamento pede só nome e celular. E-mail e outros campos
  são opcionais.
- **Finalidade e transparência:** opt-in de WhatsApp transacional separado de marketing, com
  versão do aviso de privacidade registrada (`customers.privacy_notice_version`).
- **Segurança desde a concepção** (art. 46): isolamento por RLS, criptografia de campo para
  dado sensível, nada de PII em logs ([ADR-0002](../adr/0002-isolamento-multi-tenant-rls.md)).
- **Nenhum dado real** em testes, seeds, fixtures ou prompts de IA. O gitleaks tem regras para
  CPF e CNPJ formatados.
