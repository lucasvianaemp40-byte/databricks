# Critérios de aceite: checklist por história

Copie a seção "Modelo" para a issue ou o PR da história e marque só o que se aplica. Item que
não se aplica é removido com o motivo, nunca deixado em branco. A Definition of Done geral está
no [CLAUDE.md](../../CLAUDE.md#definition-of-done). A skill `qa` usa este modelo para gerar os
testes.

## Modelo

```markdown
### Critérios de aceite: <história>

**Comportamento**
- [ ] Cenários principais em Dado/Quando/Então, cada um ligado a um teste
- [ ] Erros e estados vazios (sem horários, serviço inativo, rede caída)

**Tempo e fuso**
- [ ] Horários no fuso IANA da UNIDADE, nunca o do servidor ou do aparelho; fuso exibido
      quando diferir do dispositivo
- [ ] Testado com America/Sao_Paulo e outros fusos do Brasil (America/Manaus,
      America/Noronha, America/Rio_Branco) e com um fuso com horário de verão
- [ ] Hora local repetida ou inexistente tem comportamento definido (offset visível)
- [ ] "Agora" vem do Clock injetado; nenhum Date.now ou new Date() no domínio
- [ ] Antecedência mínima, horizonte, jornada, folgas, buffers e pausas respeitados
- [ ] Datas no formato pt-BR (dd/MM/aaaa, 24 h)

**Concorrência e consistência**
- [ ] Disputa do mesmo horário: exatamente um confirma; o outro recebe 409 + alternativas
- [ ] Idempotência: reenvio do formulário não duplica (Idempotency-Key)
- [ ] Edição concorrente: lock otimista (version) com mensagem "recarregue"
- [ ] Transições de status só pela máquina de estados (core + trigger)
- [ ] Efeitos colaterais (jobs, mensagens) na mesma transação ou idempotentes

**Multi-tenant e autorização**
- [ ] tenantId só da sessão; nenhum campo de tenant, papel, preço ou status aceito do cliente
- [ ] Teste negativo: tenant B não lê nem altera dado do tenant A (UI, action, URL direta → 404)
- [ ] Papéis: matriz atualizada (anônimo, cliente, profissional, recepção, dono) com casos
      positivos e negativos
- [ ] Tabela nova: RLS ENABLE + FORCE, políticas, FK composta, UNIQUE com tenant_id,
      caso em *.rls.test.ts

**LGPD**
- [ ] Coleta mínima justificada; base legal identificada (inventário atualizado)
- [ ] Consentimento ou opt-in registrado com versão do texto quando necessário
- [ ] Nenhuma PII em log, URL, analytics, Sentry ou prompt
- [ ] Dado novo incluído na exportação e na anonimização do titular
- [ ] Dado sensível (saúde)? então threat model + RIPD + criptografia de campo

**Segurança**
- [ ] Zod estrito em toda entrada; erro genérico sem eco de dado pessoal
- [ ] Autorização dentro da Server Action ou do Route Handler (o Proxy não autoriza)
- [ ] Route Handler mutável com assertSameOrigin ou assinatura (webhook)
- [ ] Rate limit e anti-automação em fluxo público ou caro (falha fechada)
- [ ] Sem dangerouslySetInnerHTML, sem atributo style inline, sem sql.raw com input
- [ ] Threat model atualizado se tocar dado pessoal, pagamento, autenticação ou página pública

**Acessibilidade (WCAG 2.2 AA)**
- [ ] axe sem violações em cada estado do fluxo, nos temas claro e escuro
- [ ] Fluxo completo só com teclado; foco visível; ordem lógica
- [ ] Rótulos e nomes acessíveis; aria-live ao mudar dia ou horário; erros anunciados
- [ ] Alvo de toque >= 24×24 px; contraste; zoom de 200% sem perda de conteúdo

**Mobile e rede**
- [ ] Funciona no projeto mobile (Galaxy A55) e em iPhone; layout sem rolagem horizontal
- [ ] Rede lenta: estados de carregamento; duplo clique em "confirmar" não duplica

**Observabilidade**
- [ ] Erros com requestId; métricas do fluxo (por exemplo, reserva: sucesso, 409, erro)
- [ ] Eventos de segurança relevantes logados sem PII

**Testes entregues**
- [ ] Domínio: exemplos + propriedades (*.prop.test.ts) para todo "sempre" e "nunca"
- [ ] Banco: integração e RLS (*.int.test.ts, *.rls.test.ts) se mexeu em SQL ou acesso a dados
- [ ] E2E da jornada (*.spec.ts) com axe, se mexeu em UI
- [ ] Teste de regressão que falhava antes da correção (se for bug)
- [ ] pnpm verify verde; pnpm test:db e pnpm e2e quando aplicável
```

## Exemplo preenchido (trecho): E4.3 "Confirmar agendamento pela página pública"

**Comportamento**

- Dado o salão "Studio Exemplo" com o horário das 10:00 livre para Ana, quando o cliente informa
  nome e celular, aceita o aviso de privacidade e confirma, então vê "Agendamento confirmado" com
  data e hora no fuso da unidade, e o agendamento nasce `confirmed` com a origem `online`.
- Dado que outro cliente confirmou o mesmo horário um instante antes, quando este cliente
  confirma, então recebe a mensagem "acabou de ser reservado" e 3 horários alternativos, e nada
  é gravado.

**Concorrência:** E2E com dois contextos de navegador disputando o horário (só um confirma);
integração já cobre a corrida no banco (`SlotUnavailableError`).

**Multi-tenant:** o slug de um salão nunca devolve serviço, profissional ou cliente de outro. O
`tenantId` é resolvido no servidor e não aparece no payload.

**LGPD:** só nome e celular são obrigatórios; `privacy_notice_version` gravada; opt-in de
WhatsApp separado do marketing (desmarcado por padrão); o telefone não aparece em log.

**Acessibilidade:** axe nos estados "horário selecionado", "formulário com erro" e
"confirmação"; o fluxo inteiro funciona só com teclado.
