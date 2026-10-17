# Integrações no Brasil

Integrações previstas, com os fatos que as embasam. Nada daqui está implementado. Os números
(preços, prazos) foram levantados em **16 e 17/10/2026** e mudam: confira a fonte antes de usar
em preço ou contrato. Marcas: **[V]** verificado na fonte oficial (documentação do fornecedor,
gov.br, Planalto, por busca restrita ao domínio oficial); **[S]** fonte secundária; **não
verificado** quando não houve confirmação. Questões legais estão **a validar com jurídico**.

## 1. WhatsApp Business Platform (Cloud API)

### Preço

| Fato | Fonte |
|---|---|
| Cobrança **por mensagem** desde 01/07/2025, nas categorias marketing, utility, authentication e service | [V] Meta |
| **Desde 01/10/2026** são cobradas também as mensagens de **serviço** e as de **utility dentro da janela de 24 h** | [V] Meta |
| Franquia: **1.000 mensagens de serviço por número de telefone por mês**, sem acumular | [V] Meta |
| Brasil, utility e authentication: **US$ 0,0068** por mensagem ("0.68 USD cent"), cerca de **R$ 0,035** | [V] Meta (USD); [S] (BRL) |
| Brasil, marketing: cerca de **US$ 0,0625**, ou **R$ 0,32** | [S] |
| Faturamento em BRL para contas brasileiras desde jul/2026 | [V] Meta |
| A Meta só muda preços no 1º dia de cada trimestre | [V] Meta |

Custo de um salão médio (exemplo da pesquisa):

| Cenário | Mensagens/mês | Custo |
|---|---|---|
| 400 atendimentos × (confirmação + lembrete 24 h), utility | 800 | ≈ R$ 28 |
| Respostas de serviço (cliente responde, recepção responde) | até 1.000 por número | dentro da franquia |
| Campanha "volte a cortar" para 300 clientes, marketing | 300 | ≈ R$ 96 |

**Consequência de produto:** o WhatsApp transacional cabe no plano, com franquia e excedente
cobrado. O marketing é **crédito pré-pago separado**.

### Regras de template [V]

- **Opt-in** antes de qualquer template, com o nome da empresa e a intenção claros
  (`customers.whatsapp_opt_in_at`).
- **Utility** precisa ser não promocional e ligado a uma transação do usuário. Conteúdo misto
  (lembrete + promoção) é **marketing**. Desde 16/04/2025, a Meta pode recategorizar sem aviso
  quem fizer mau uso. Por isso: templates enxutos, sem cupom e sem "aproveite".
- OTP do cliente usa template de categoria **authentication** (botão de copiar código).

Templates sugeridos (pt_BR; a categoria final é decisão da Meta):

| Nome | Uso | Categoria pretendida |
|---|---|---|
| `agendamento_confirmado_v1` | confirmação com data, hora, serviço, profissional e endereço; botão "Ver ou remarcar" | utility |
| `lembrete_24h_v1` | lembrete com botões "Confirmo" e "Preciso remarcar" | utility |
| `sinal_pix_pendente_v1` | sinal a pagar até o prazo, "o valor é abatido do serviço" | utility |
| `agendamento_cancelado_v1` | aviso de cancelamento com link para agendar de novo | utility |
| `vaga_lista_espera_v1` | oferta de vaga com prazo | utility (**risco de virar marketing**, não verificado) |
| `codigo_verificacao` | OTP de login do cliente | authentication |

### Números e onboarding [V]

- **Tech Provider:** o salão paga a Meta diretamente e nós cobramos o nosso serviço à parte.
  **Solution Partner** exige linha de crédito e é um processo longo.
- **Embedded Signup** devolve `waba_id` e `phone_number_id` e um código trocado por um token de
  negócio (Tech Providers usam só tokens de negócio). Há limite de novos clientes por semana até
  passar pelas verificações (os números variam entre páginas da Meta).
- **Coexistence:** o salão conecta à API o mesmo número que já usa no app WhatsApp Business,
  **sem perder o app**. Isso é crucial no Brasil.

**Recomendação:**

- **MVP:** **número da plataforma** (uma WABA nossa), com o nome do salão como variável, custo
  nosso e franquia no plano. Fallback gratuito: link `wa.me` com texto pronto, que a recepção
  envia pelo próprio app. Abrir em paralelo o processo de Tech Provider.
- **Fase 2:** "use seu próprio número" via Embedded Signup + Coexistence, com o salão pagando a
  Meta.

**Segurança:**

- webhook com `X-Hub-Signature-256` (HMAC-SHA256 do corpo cru com o app secret; padrão
  conhecido da Meta, não verificado na pesquisa), comparação em tempo constante, deduplicação e
  processamento assíncrono;
- token por salão cifrado;
- o gitleaks tem regras para tokens `EAA…` e app secrets
  ([`.gitleaks.toml`](../../.gitleaks.toml)).

## 2. Pix (sinal e pagamento online)

| Provedor | Taxa do Pix recebido | Expiração do QR | Autenticidade do webhook | Multi-salão | Pix Automático |
|---|---|---|---|---|---|
| **Mercado Pago** | 0% a 0,99%, conforme perfil e prazo [S] | `date_of_expiration`: **30 min a 30 dias**, padrão 24 h [V] | `x-signature` (`ts`, `v1`): HMAC-SHA256 de `id:[data.id];request-id:[x-request-id];ts:[ts];` [V] | **OAuth por vendedor**, `application_fee` no Checkout Transparente [V] | não verificado |
| Efí | 1,19% [S] | não verificado | mTLS [S] | split só entre contas Efí [V] | não verificado |
| Asaas | R$ 1,99 por Pix recebido [S] | por data de vencimento | token no cabeçalho (não verificado) | subcontas + split por `walletId` [V] | **sim**, sem custo extra [V] |
| Stripe | 1,19% [V] | 60 s a 14 dias, padrão 4 h [V] | `Stripe-Signature` | Connect | **indisponível para empresa no Brasil** [V]; Pix só por convite [V] |

**Recomendações:**

1. **O dinheiro do sinal vai direto para a conta do salão** (OAuth do Mercado Pago, ou subconta
   Asaas no nome do salão). A plataforma não custodia valores: o risco regulatório de atuar como
   instituição de pagamento ou subcredenciador fica **a validar com jurídico**. Receita por
   transação, se houver, via `application_fee`.
2. **Sinal (tíquete de R$ 20 a 50): Mercado Pago no MVP.** Taxa percentual baixa vale mais que
   taxa fixa: num sinal de R$ 30, 0,99% dá R$ 0,30, enquanto R$ 1,99 fixo dá 6,6%. Muitos salões
   já têm conta e maquininha do Mercado Pago.
3. **Clube de assinatura (fase 2):** Asaas (Pix Automático e cartão recorrente) ou Efí. O Pix
   Automático foi lançado pelo BCB em 16/06/2025 [V].
4. **Devolução por API** é obrigatória para "salão cancelou", "cancelou dentro da janela" e "Pix
   chegou depois do hold" ([modelo, seção 6](modelo.md#6-holds-e-sinal-via-pix)). Endpoint por
   provedor não verificado em detalhe.
5. Interface `PaymentProvider` (`createPixCharge`, `getPayment`, `refund`, `verifyWebhook`) para
   plugar outros provedores.
6. **Webhook é notificação, não verdade:** reconsultar `GET /v1/payments/{id}` com o token **do
   salão** e conferir valor, txid e tenant antes de mudar o estado. Idempotência por
   `(provider, provider_event_id)`. A API Pix do BCB protege o callback com mTLS.

## 3. NFS-e nacional

| Fato | Fonte |
|---|---|
| LC 214/2025, art. 62: desde **01/01/2026** os municípios emitem no **padrão nacional** (ambiente nacional ou emissor próprio integrado) | [V] gov.br/fazenda |
| Res. CGSN nº 191/2026: **ME e EPP do Simples** usam o **Emissor Nacional a partir de 01/11/2026**, pela web ou por API (adiado de 01/09/2026) | [V] gov.br/receitafederal |
| **MEI** emite NFS-e no padrão nacional desde 01/09/2023; dispensado de emitir para pessoa física | [V] gov.br/nfse |
| IBS/CBS na NFS-e: regime normal desde out–dez/2026; Simples e MEI a partir de 01/01/2027 | [S], não verificado no primário |
| API da Sefin Nacional: `POST /nfse` gera a nota de forma síncrona a partir de uma DPS assinada; REST/JSON com **TLS mútuo** e **certificado ICP-Brasil A1** | [V] manual para contribuintes v1.2 |

**Implicação:** para MEI e Simples, a partir de nov/2026, **uma integração cobre o país**.
**Fase 2** via agregador (custódia do certificado A1, filas, PDF), emitindo ao concluir o
atendimento e na renovação de assinatura. Avaliar integração direta depois.

## 4. Lei do Salão-Parceiro

A **Lei 13.352/2016** inseriu os arts. 1º-A a 1º-D na **Lei 12.592/2012** [V]:

- contrato de parceria por escrito entre o salão e o profissional (cabeleireiro, barbeiro,
  esteticista, manicure, pedicure, depilador, maquiador);
- o salão **centraliza pagamentos e recebimentos** e **retém a cota-parte** e os tributos do
  profissional;
- a cota do profissional **não integra a receita bruta do salão**, mesmo com nota unificada;
- o contrato precisa de **homologação** pelo sindicato (ou pelo órgão do Ministério do
  Trabalho). O parágrafo exato não foi verificado;
- há vínculo de emprego se não houver contrato formalizado ou se o profissional exercer funções
  diferentes das do contrato (art. 1º-C) [S];
- o STF declarou a lei constitucional (**ADI 5625**), mas o contrato que dissimula vínculo de
  emprego é nulo [S].

**Impacto no produto:**

- `staff.engagement_type = 'partner'` [fundação];
- regime de cota-parte nos lançamentos e relatório de repasse (bruto, cota do salão, retenções,
  líquido) [planejado];
- datas de contrato e homologação e upload do contrato (fase 3);
- split automático (fase 3);
- autonomia do parceiro sobre a própria agenda (permissões por vínculo);
- **sem parecer jurídico na UI**: avisos do tipo "consulte seu contador".

## 5. Google Calendar (fase 2)

- **Saída:** nossa agenda vai para um **calendário secundário** do profissional, com o escopo
  mais estreito, `calendar.app.created`, que só alcança calendários criados pelo app [V]. Importar
  o "ocupado" do calendário pessoal exige escopo mais amplo e verificação do app OAuth (a
  classificação de cada escopo não foi verificada).
- **Push** [V]: `events.watch` cria canais que **não se renovam sozinhos** (TTL padrão de 7
  dias); a notificação só avisa que algo mudou, então buscar com **`syncToken`**; **410 Gone**
  exige refazer o sync completo.
- Seremos **cliente OAuth**: aplicar o capítulo V10 do ASVS no threat model da integração.

## 6. Reserve with Google (fase 3)

**Appointments Redirect** está disponível no Brasil, e beleza é elegível [V]. Exige contrato com
cada estabelecimento e dados que casem com o Google Maps. No MVP: checklist de onboarding para
pôr o link de agendamento no Perfil da Empresa no Google e no Instagram (manual e grátis).

## Referências

- WhatsApp:
  - preços: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
  - categorização de templates: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization
- Mercado Pago:
  - webhooks: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
  - Pix: https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix
- Stripe Pix: https://docs.stripe.com/payments/pix/accept-a-payment
- Asaas, split de pagamentos: https://docs.asaas.com/docs/split-de-pagamentos
- API Pix (BCB): https://github.com/bacen/pix-api
- NFS-e:
  - MEI: https://www.gov.br/nfse/pt-br/mei-prestadores-de-servico-de-todo-o-pais-estao-obrigados-a-emitir-nfs-e
  - ME e EPP do Simples: https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/agosto/simples-nacional-nfs-e-nacional-sera-obrigatoria-para-me-e-epp-a-partir-de-1o-de-novembro-de-2026
- Lei 13.352/2016: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2016/lei/l13352.htm
- Lei 12.592/2012: https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2012/lei/l12592.htm
- Google Calendar, push: https://developers.google.com/workspace/calendar/api/guides/push
- Google Actions Center (agendamentos): https://developers.google.com/actions-center/verticals/appointments/redirect/policies/platform-policies
