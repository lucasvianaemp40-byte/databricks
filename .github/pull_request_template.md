## O que muda e por quê

<!-- Uma ou duas frases sobre o problema e a solução. Link da issue: Closes #123 -->

## Como foi testado

<!-- Comandos rodados e resultado. O gate local é `pnpm verify`; banco e E2E são separados. -->

- [ ] `pnpm verify` (format:check, lint, typecheck, test e build) passou localmente
- [ ] `pnpm test:db` passou (obrigatório se mexeu em `packages/db`, RLS ou query)
- [ ] `pnpm e2e` passou (obrigatório se mexeu em tela, rota, cabeçalho ou fluxo de reserva)
- [ ] Regra de negócio nova tem teste de exemplo e, no domínio, teste de propriedade (fast-check)

## Segurança e multi-tenant

- [ ] Toda leitura/escrita de dado de salão passa por `withTenant(...)` ou por função que recebe
      `TenantTransaction`; o `tenantId` vem da sessão, nunca de parâmetro, corpo ou URL
- [ ] Tabela nova tem `tenant_id`, FK composta `(tenant_id, id)`, RLS `ENABLE` + `FORCE`,
      políticas e teste `*.rls.test.ts` (inclusive tentativa de acesso cruzado entre salões)
- [ ] Server Action / Route Handler novo verifica sessão, papel e tenant na primeira instrução
      (`tenantAction`/`ownerAction` ou `requireXxx()`); recurso de outro salão responde 404
- [ ] Nenhum `sql.raw`/SQL com interpolação, `dangerouslySetInnerHTML` ou redirect para URL
      vinda do usuário
- [ ] Entradas externas validadas com Zod (`.strict()`); erros não vazam detalhe interno
- [ ] Nenhum segredo no código, em fixture ou em log; variável nova declarada em `env.ts`,
      no `turbo.json` do pacote e no `.env.example`

## LGPD

- [ ] Dado pessoal novo (nome, telefone, e-mail, CPF, nascimento, observações) tem finalidade e
      base legal documentadas e entra na exportação e na anonimização do titular
- [ ] Nenhum dado pessoal em log, mensagem de erro, URL, analytics ou nome de arquivo
- [ ] Fixtures e seeds usam só dados sintéticos

## Data e hora

- [ ] Instantes gravados como `timestamptz` (UTC); horário de parede calculado com o fuso IANA
      da unidade (Temporal), nunca com o fuso do servidor ou do navegador
- [ ] No domínio, nada de `Date.now()`, `new Date()` sem argumento, `Temporal.Now` ou
      `Math.random()`: o `Clock` é injetado
- [ ] Casos de borda considerados quando aplicável: virada de dia, fuso diferente entre unidade e
      cliente, horário de verão histórico

## Dependências e CI

- [ ] Sem dependência nova; ou a dependência nova tem justificativa abaixo (manutenção, licença,
      scripts de instalação, alternativa nativa considerada) e respeita a quarentena de 3 dias
- [ ] Mudanças em `.github/`, `.claude/`, `pnpm-workspace.yaml` ou no lockfile estão explicadas

## Observações para quem revisa

<!-- Riscos, decisões, partes que merecem atenção, prints de tela (sem dados reais). -->
