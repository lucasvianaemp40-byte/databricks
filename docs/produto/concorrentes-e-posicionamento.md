# Concorrentes e posicionamento

Levantamento de 16 e 17/10/2026. Os preços vêm de páginas dos próprios fornecedores, muitas
sem data e algumas divergentes entre si: **trate como faixa**, não como tabela atual. Marcas:
[V] página oficial do fornecedor; [S] fonte secundária ou página sem data.

## 1. Mercado

Segundo o Sebrae [S], foram cerca de **236 mil novos negócios de beleza em 2025** (+18,5% sobre
2024). **94% são MEI**, 5% ME e 1% EPP. O cliente típico é **muito pequeno**, então:

- o onboarding precisa ser self-service e levar menos de 10 minutos;
- o preço precisa ser baixo e previsível, em BRL;
- a fricção para o cliente final precisa ser mínima: Pix, WhatsApp, sem app e sem senha.

## 2. Comparativo

| Produto | Foco | Preço observado (1–2 profissionais) | Destaques | Fonte |
|---|---|---|---|---|
| **Trinks** (grupo Stone) | salões e barbearias no Brasil; marketplace | R$ 110/mês no mensal, R$ 76/mês no anual; **fidelidade de 6 e 12 meses** nos termos | clube de assinatura com NFS-e; NFS-e e rotina de WhatsApp como **adicionais pagos**; maquininha e split via Stone | preços [S]; termos e funções [V] |
| **Avec** (ex-SalãoVIP) | salões e estética | R$ 74,90 a 88,90/mês | split de pagamento na maquininha, conta digital, clube de assinatura | [S] |
| **AppBarber / AppBeleza** | barbearias | R$ 79,90 (1 profissional) a R$ 219,90 (mais de 15); **cobra por todos os cadastrados**, mesmo inativos | app white-label do estabelecimento nas lojas | [V] central de ajuda |
| **Belasis** | salões e clínicas | R$ 99 (Lite) / R$ 189 (Pro) | agenda, financeiro | [S] |
| **Simples Agenda** | genérico | a partir de R$ 39,90 (1 profissional); sem fidelidade | agenda e financeiro | [S] |
| **Booksy** | barbearias, global, marketplace | EUA: US$ 29,99 + US$ 20 por profissional extra; **Boost**: 30% da 1ª visita do cliente novo do marketplace | No-Show Protection (depósito ou taxa com cartão salvo) | [V] |
| **Fresha** | global, marketplace | EUA: US$ 19,95 (solo) ou US$ 14,95 por membro; taxa sobre **cliente novo do marketplace** | marketplace, pagamentos | [V] |
| **AgendaPro** | América Latina, multivertical | preço no Brasil não verificado | agenda, comissões, POS, API | [V] página antiga |
| **Calendly** (referência de UX) | genérico | US$ 10 a 16 por usuário/mês | antecedência, buffers e round-robin como parâmetros de primeira classe | [V] |

## 3. Dores observadas viram requisitos

| Dor | Evidência | Nossa resposta |
|---|---|---|
| Multa por cancelar plano anual, cobrança depois do cancelamento, renovação automática "abusiva" | Reclame Aqui (Trinks) [S]; termos com fidelidade [V] | **Sem fidelidade.** Anual só como desconto pré-pago com reembolso pró-rata. Botão "cancelar assinatura" com efeito imediato e teste automatizado de que nenhuma cobrança acontece depois |
| "Sistema não é confiável": cadastros perdidos, agendamentos futuros cancelados, notificações que não saem | Reclame Aqui (Trinks) [S] | **Integridade transacional** (`EXCLUDE`, FKs compostas, máquina de estados e auditoria no banco), PITR, exportação a qualquer momento, alerta de falha de lembrete |
| **Erros de comissão** | Reclame Aqui (Trinks, set/2026) [S] | Comissão como **snapshot por item**, lançamento idempotente, extrato explicável ("por que este valor"), fechamento mensal travado |
| Comissão de marketplace sobre **cliente que já era do salão** | reviews da Fresha [S]; Boost da Booksy [V] | **Nenhuma comissão sobre agendamento.** Se um dia houver marketplace, atribuição auditável e contestável |
| Cobrança em dólar acima do anunciado; não consegue cancelar | Reclame Aqui (Booksy) [S] | Cobrança em BRL, preço fechado, cancelamento self-service |
| Repasse aos profissionais retido na plataforma | Reclame Aqui (Avec, caso isolado) [S] | Sinal cai **na conta do salão** (OAuth do PSP), sem custódia nossa |
| Cobrança por profissional cadastrado mesmo inativo | central de ajuda da AppBarber [V] | Cobrar por **profissional ativo com agenda** no mês |
| WhatsApp e NFS-e como adicionais pagos | Trinks [V] | WhatsApp transacional **incluído** com franquia (o custo real é baixo, ver [integrações](../dominio/integracoes.md#1-whatsapp-business-platform-cloud-api)); NFS-e no plano intermediário |

## 4. Padrões que vale copiar

- **Proteção contra no-show** (Booksy) [V]: depósito por serviço, clientes confiáveis isentos.
  No Brasil, a versão de menor fricção é o **sinal via Pix**, que ainda evita chargeback.
- **Confirmação 24 h antes por WhatsApp e avaliação no fechamento** (Trinks) [V].
- **App com a marca do salão** (AppBarber) [V]: uma **PWA instalável** resolve a maior parte sem
  passar pelas lojas.
- **Antecedência, buffers e round-robin como parâmetros** (Calendly) [V].
- **Reserva temporária do horário** (cal.com, código lido) [V]: o cal.com usa uma chave de
  idempotência que só protege o horário **idêntico**. O nosso `EXCLUDE` com `&&` cobre também a
  sobreposição parcial.

## 5. Posicionamento

> Para salões e barbearias pequenos que perdem dinheiro com faltas e tempo com WhatsApp
> manual, o **Agenda Salão** é a agenda online que confirma e lembra pelo WhatsApp, cobra o
> sinal via Pix direto na conta do salão e **nunca marca dois clientes no mesmo horário**.
> Diferente dos incumbentes, não tem fidelidade, não cobra comissão sobre o seu cliente e
> deixa o salão sair levando os dados quando quiser.

**Diferenciais:**

1. **Sem fidelidade e com cancelamento self-service.**
2. **Garantia anti-overbooking** no banco, com trilha de auditoria de quem mudou o quê.
3. **Comissão e cota-parte auditáveis**, com extrato explicável e suporte à Lei do
   Salão-Parceiro.
4. **Preço em BRL**, por profissional ativo, **sem comissão sobre cliente próprio**.
5. **Custo de WhatsApp transparente:** transacional incluído, marketing em crédito separado.
6. **LGPD de verdade:** dados no Brasil, exportação e anonimização na mão do salão, anamnese
   protegida.
7. **Multi-unidade com fuso correto** desde o início (Manaus, Noronha, Acre).

**Hipótese de preço** (a validar com clientes; não é tabela): faixa competitiva com os
incumbentes para 1–2 profissionais (R$ 40 a 110/mês observados), cobrando por profissional
ativo, com franquia de mensagens transacionais e crédito de marketing à parte.

## 6. Riscos de mercado

- Incumbentes com maquininha e conta digital (Stone, Avec) amarram o salão pelo financeiro.
  Nossa resposta é integrar o PSP que o salão já usa (Mercado Pago) e não competir em
  adquirência.
- Mudanças de preço e de categorização da Meta afetam a margem. Mitigação: franquia por plano e
  monitoramento do custo por agendamento.
- O cliente MEI é sensível a preço e tem churn alto. Ativação rápida é o que mais importa
  ([métricas](mvp-e-roadmap.md#5-métricas)).

## Fontes

- Trinks:
  - planos: https://negocios.trinks.com/planos/
  - termos de uso: https://negocios.trinks.com/termos-de-uso/
- AppBarber: https://appbarber-appbeleza.zendesk.com/hc/pt-br/articles/360001701331
- Booksy:
  - preços: https://biz.booksy.com/pricing
  - No-Show Protection: https://support.booksy.com/hc/en-us/articles/16487371034130
- Fresha: https://www.fresha.com/pricing
- Calendly: https://calendly.com/pricing
- Sebrae (mercado): https://agenciasebrae.com.br/cultura-empreendedora/a-cada-hora-27-negocios-de-beleza-sao-abertos-no-pais-crescimento-foi-de-185-em-2025/
- Reclame Aqui:
  - Trinks: https://www.reclameaqui.com.br/empresa/trinks/
  - Booksy: https://www.reclameaqui.com.br/empresa/booksy/lista-reclamacoes/
