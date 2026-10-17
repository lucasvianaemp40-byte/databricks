---
name: pre-pr
description: Portão de segurança e qualidade antes de abrir ou atualizar um Pull Request no Agenda Salão (verify, revisão AppSec do diff, pentest de isolamento, LGPD, migrações, dependências novas e descrição do PR). Use antes de criar ou atualizar qualquer PR.
---

# pre-pr

Nesta ordem; pare e corrija ao primeiro bloqueio:

1. Skill `verify`. Tudo verde ou explicitamente "não executado" com motivo.
2. Subagente `appsec-reviewer` (ferramenta Agent) no diff da branch
   (`git diff --merge-base origin/HEAD`). Corrija ou justifique cada achado verificado.
3. O diff toca autenticação, autorização, queries, RLS, Server Actions, webhooks ou a página
   pública? Skill `pentest-tenant` no diff.
4. O diff toca dado pessoal, anamnese, logs, analytics ou integrações? Skill `lgpd-check`.
5. Há migração ou mudança de schema? Skill `review-migration` com veredito APROVAR.
6. Dependência nova ou atualizada (`package.json`, `pnpm-lock.yaml`): liste pacote, versão
   exata, idade da versão (quarentena >= 3 dias), mantenedor, licença, scripts de instalação
   (`allowBuilds`) e por que é necessária. Prefira não adicionar.
7. Descrição do PR conforme a skill `steward`: o quê e por quê, riscos, como foi testado
   (comandos e resultados), achados de segurança tratados e aceitos (com justificativa) e o
   que não foi verificado.
