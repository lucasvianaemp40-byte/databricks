# Segurança

Padrão de verificação: **OWASP ASVS 5.0.0, nível 2**, como Definition of Done de segurança,
mais OWASP Top 10:2025 e OWASP API Security Top 10:2023. Itens de nível 3 entram quando são
baratos, como CSP com nonce, COOP e `frame-ancestors`.

| Documento | Conteúdo |
|---|---|
| [modelo-de-ameacas.md](modelo-de-ameacas.md) | STRIDE por componente, LINDDUN resumido e casos de abuso do agendamento |
| [asvs-l2.md](asvs-l2.md) | Checklist ASVS 5.0 L2 por capítulo: atendido na fundação, planejado ou desvio aceito |
| [headers-e-csp.md](headers-e-csp.md) | CSP por nonce, cabeçalhos estáticos, CSRF, cookies e como testar |
| [resposta-a-incidentes.md](resposta-a-incidentes.md) | Runbook, papéis, prazos da ANPD (Res. CD/ANPD 15/2024) e playbooks |
| [supply-chain.md](supply-chain.md) | Como adicionar dependência, quarentena, hotfix, pins, Renovate e varreduras |
| [threat-models/](threat-models/README.md) | Threat models por feature, gerados antes da implementação |
| [auditorias/](auditorias/README.md) | Relatórios de auditoria e de revisão diferencial |

Relato de vulnerabilidade: [SECURITY.md](../../SECURITY.md).

## Princípios

1. **O tenant vem da sessão**, nunca do input. Recurso de outro tenant responde 404.
2. **Defesa em profundidade:** o DAL autoriza, a RLS isola e as constraints garantem a
   integridade ([ADR-0002](../adr/0002-isolamento-multi-tenant-rls.md)).
3. **O Proxy não autoriza nada.** A autorização acontece dentro de cada Server Action, Route
   Handler e DAL.
4. **Falha fechada** (OWASP A10:2025). Sem contexto de tenant, nenhuma linha. Sem Redis, nenhum
   OTP. Erro ao ler a membership vira 403. Pagamento não confirmado mantém o agendamento
   pendente.
5. **Entrada validada com Zod estrito.** `tenantId`, `role`, `status` e `price` nunca vêm do
   cliente.
6. **Sem PII nem segredo** em log, URL, analytics, Sentry ou prompt de IA.
7. **Cadeia de suprimentos** com quarentena, pins e scripts bloqueados
   ([ADR-0007](../adr/0007-politica-de-supply-chain.md)).

## Definition of Done de segurança por PR

- [ ] Tabela nova em `app` tem `tenant_id`, FK composta, UNIQUE começando por `tenant_id`, RLS
      `ENABLE` + `FORCE` e as políticas `tenant_isolation`/`app_access`. A função de
      invariantes e os meta-testes passam.
- [ ] Toda Server Action usa o cliente com guarda (`tenantAction` ou `ownerAction`, quando
      existirem), tem `inputSchema` Zod estrito e devolve um DTO mínimo.
- [ ] Todo Route Handler que altera estado valida a origem (`assertSameOrigin`) ou a
      assinatura (webhook).
- [ ] Nenhum `sql.raw` com input, nenhum `dangerouslySetInnerHTML` e nenhum atributo `style`
      inline.
- [ ] Dado pessoal novo classificado no [inventário](../lgpd/inventario-de-dados.md) e
      incluído na exportação e na anonimização.
- [ ] Teste negativo cross-tenant para todo acesso novo a dado. Testes de autorização positivos
      e negativos.
- [ ] Todo acesso a dado termina dentro do callback de `withTenant` (nada de `after()`,
      `setTimeout` ou builder devolvido; `Promise.allSettled` em vez de `Promise.all` com ramos
      que podem falhar). `id` e `tenant_id` nunca vêm do cliente em INSERT ou upsert, e
      `IdentifierConflictError` vira 404/409 genérico.
- [ ] Nenhum erro do banco cru em log (o `DrizzleQueryError` e o `cause` trazem os parâmetros
      da consulta).
- [ ] Chamada de rede de saída só pelo `safeFetch` (quando existir).
- [ ] Threat model atualizado quando a feature tocar dado pessoal, pagamento, autenticação ou
      página pública.

## Registro de desvios

Desvios aceitos do ASVS ficam em [asvs-l2.md](asvs-l2.md#desvios-aceitos). Cada um tem
justificativa, mitigação e revisão prevista. Um desvio novo entra no mesmo PR que o cria.
