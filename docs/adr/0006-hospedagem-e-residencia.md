# ADR-0006: Hospedagem e residência de dados no Brasil

- **Status:** Proposto. Depende de validação de custo, plano dos fornecedores e contrato. Não
  há deploy nesta iteração.
- **Data:** 2026-10-17
- **Relacionados:** [arquitetura, seção 8](../arquitetura.md#8-hospedagem-e-residência-de-dados-proposta),
  [checklist contratual](../lgpd/checklist-contratual.md)

## Contexto

- **Público:** salões no Brasil, quase todos MEI. A maior parte do tráfego vem de celular,
  principalmente Android, então a latência importa na página pública.
- **LGPD:**
  - a lei não exige armazenamento no Brasil, mas toda transferência internacional precisa de
    uma das hipóteses do art. 33;
  - a Resolução CD/ANPD nº 19/2024 tornou obrigatórias as cláusulas-padrão contratuais da ANPD
    para transferências por base contratual, com adequação dos contratos até 23/08/2025
    (fonte secundária);
  - a Resolução CD/ANPD nº 32/2026 reconheceu adequação recíproca com a União Europeia (fonte
    secundária).

  **A validar com jurídico.**
- **Next.js:** vários advisories de 2026 afetam só instalações self-hosted (cache poisoning,
  RCE em Windows, custom server), e a Vercel aplicou mitigação de plataforma no
  CVE-2025-29927.
- **Regiões verificadas na documentação dos fornecedores**, em 16/10/2026:

  | Fornecedor | Região no Brasil |
  |---|---|
  | Vercel | `gru1` (São Paulo). O default de funções é `iad1` |
  | Neon | `aws-sa-east-1` |
  | Fly.io | `gru`, com Managed Postgres |
  | Upstash | `sa-east-1` |
  | Supabase | `sa-east-1` |
  | Railway | nenhuma região no Brasil |

## Decisão (proposta)

| Componente | Escolha | Detalhes |
|---|---|---|
| App web | **Vercel**, funções em `gru1` | `regions: ["gru1"]` explícito. `attachDatabasePool` do `@vercel/functions` para o pool do `pg` |
| Worker | **Fly.io `gru`** | 1 a 2 Machines pequenas, imagem Node 24 |
| PostgreSQL | **Neon `aws-sa-east-1`** | branching por PR, PITR. String *pooled* para o app (seguro com `set_config(..., true)`) e *direct* para migrações e worker. TLS `sslmode=verify-full` |
| Rate limit | **Upstash Redis `sa-east-1`** | página pública e OTP |
| Plano B | **AWS RDS `sa-east-1`** | se o volume ou a compliance exigirem Multi-AZ, VPC e IAM |

- Os papéis `app_*` são criados **por SQL** (migração 0000), nunca pelo console do provedor:
  papéis criados no console da Neon entram num grupo com BYPASSRLS (não verificado na
  documentação oficial). A função de invariantes recusa papel de runtime com BYPASSRLS.
- O deploy do app acontece pela integração Git da Vercel. Migrações e infraestrutura passam
  pelo Actions com `environment` protegido e OIDC, e o job privilegiado não roda
  `pnpm install` (ver [supply chain](../seguranca/supply-chain.md)).
- **Subprocessadores fora do Brasil**, com o mínimo de dado pessoal:

  | Subprocessador | Regra |
  |---|---|
  | Meta (WhatsApp) | inevitável |
  | Sentry | região UE se disponível, `sendDefaultPii: false` |
  | Provedor de e-mail | — |
  | Cloudflare Turnstile | — |

  Todos com cláusulas-padrão da ANPD no contrato.

## Consequências

- **Positivas:**
  - dados primários (banco, fila, auth, rate limit) em São Paulo;
  - baixa latência;
  - pouca operação;
  - preview por PR com banco por branch.
- **Negativas e riscos:**
  - três fornecedores para contratar e monitorar;
  - preço regional de `gru1` não verificado;
  - suporte da Vercel ao pnpm 11 não documentado (testar ou usar `--prebuilt`);
  - disponibilidade do PostgreSQL 18 na Neon `aws-sa-east-1` não verificada. O schema roda no
    16 e no 18 de propósito;
  - o cabeçalho de IP confiável da Vercel (`x-real-ip`) não foi verificado.
- **Ações decorrentes:**
  - validar preços e contratos (DPA e cláusulas-padrão);
  - registrar os subprocessadores na lista pública;
  - teste pós-deploy dos invariantes com o papel real (`assert_security_invariants`);
  - restauração de backup testada a cada trimestre;
  - bloquear `TRACE`, `TRACK` e `CONNECT` com 405 na borda (Vercel Firewall ou CDN): o Next
    16.4 responde a eles sem cabeçalhos de segurança. Conferir antes se a Vercel já os recusa
    (não verificado);
  - configurar `APP_URL` e `APP_ENV` por ambiente em runtime: o mesmo build serve preview e
    produção sem rebuild ([README do web](../../apps/web/README.md#variáveis-de-ambiente));
  - Sentry (região, túnel e redaction) conforme o [ADR-0010](0010-observabilidade.md).

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Tudo na AWS `sa-east-1` (ECS ou Lambda + RDS) | Mais controle, mais operação e custo fixo, sem branching por PR. Fica como plano B |
| Supabase | Paga-se por recursos que não usaríamos (auth, storage, realtime), e o RLS idiomático é por usuário |
| Railway | Sem região no Brasil |
| Fly.io para tudo (app + MPG) | Next.js self-hosted herda os advisories exclusivos de self-host |
| Inngest ou Trigger.dev para jobs | Ver [ADR-0005](0005-fila-pg-boss.md) |

## Referências

- Regiões da Vercel: https://vercel.com/docs/regions
- Regiões da Neon: https://github.com/neondatabase/website/blob/main/content/docs/introduction/regions.md
- Regiões da Fly.io: https://github.com/superfly/docs/blob/main/reference/regions.mdx
- LGPD, art. 33: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm
- ANPD: https://www.gov.br/anpd
