# Direitos do titular: requisitos de engenharia

Como o produto atende os direitos do art. 18 da LGPD. Prazos e roteamento são propostas **a
validar com jurídico**. Nada desta página está implementado ainda, exceto o que está marcado
como [fundação].

## 1. Quem responde a quê

- **Cliente final:** o controlador é o **salão**. A plataforma (operadora) fornece as
  ferramentas e encaminha ao salão o pedido que chegar a ela.
- **Pedido à plataforma sobre dados de um salão:** a plataforma informa ao titular quem é o
  controlador e encaminha o pedido ao salão (art. 18, § 4º, I). O formulário do encarregado da
  plataforma roteia pelo tenant.
- **Donos e equipe:** para dados de conta e de acesso, a controladora é a **plataforma**, que
  responde diretamente.

## 2. Prazos (art. 19)

| Formato | Prazo |
|---|---|
| Confirmação de existência ou acesso em formato **simplificado** | **imediato** |
| Declaração **completa** (origem, critérios, finalidade) | até **15 dias** do requerimento |

Agente de pequeno porte tem prazos em dobro pela Res. CD/ANPD nº 2/2022, exceto em tratamento
de alto risco. Confirmar com o jurídico se vale para o salão (MEI e ME) e para a plataforma.

## 3. Direito × fluxo × engenharia

| Direito (art. 18) | Fluxo no produto | Requisito de engenharia |
|---|---|---|
| I e II. Confirmação e acesso | **Central de privacidade** na página pública do salão: o cliente se autentica por OTP e vê ou baixa os dados que aquele salão tem | Endpoint de exportação por titular **dentro do tenant** (`withTenant`). Formato simplificado na hora; completo assíncrono |
| III. Correção | o cliente edita nome e e-mail; telefone por fluxo de troca (OTP no número antigo ou conferência presencial pelo salão) | UPDATE em `customers` auditado. Troca de telefone notifica o número antigo |
| IV e VI. Anonimização, bloqueio e eliminação | pedido entra numa fila do salão com SLA; execução automática depois de N dias se o salão não indicar conservação legal (art. 16) | Função `anonymizeCustomer(tenant, customer)` (ver seção 4). Tombstone para reaplicar depois de restaurar backup |
| V. Portabilidade | exportação JSON + CSV (agendamentos, serviços, preferências) | Job assíncrono; link assinado de curta duração (expira em 24 h); sem dado de outro titular |
| VII. Compartilhamento | página pública com a lista de suboperadores | gerada da mesma lista do DPA ([checklist](checklist-contratual.md)) |
| VIII. Informação sobre não consentir | texto do opt-in com as consequências | versão do texto registrada (`privacy_notice_version`) [fundação: coluna] |
| IX. Revogação do consentimento | controles separados para marketing, dado de saúde (anamnese) e uso de imagem | consentimento append-only com finalidade, versão, data, canal e evidência. Revogar marketing zera `marketing_consent_at`; revogar dado de saúde dispara a eliminação da anamnese |
| Revisão de decisão automatizada (art. 20) | — | Não há decisão automatizada com efeito relevante no MVP. Se surgir (por exemplo, exigir sinal automaticamente após no-shows), documentar o critério e oferecer revisão humana pelo salão |

## 4. Anonimização do cliente

Já existe no banco [fundação] o CHECK `customers_anonymized_without_contact`: uma linha com
`anonymized_at` preenchido **não pode** ter telefone, e-mail, opt-in de WhatsApp nem
consentimento de marketing.

A função de anonimização [planejado] deve, numa transação:

1. substituir `full_name` por um marcador ("Cliente removido") e apagar `phone_e164`, `email`,
   `whatsapp_opt_in_at` e `marketing_consent_at`;
2. preencher `anonymized_at`;
3. apagar ficha técnica, anamnese e fotos (inclusive no bucket), e consentimentos depois do
   prazo de prova;
4. limpar textos livres ligados ao cliente (`appointments.cancellation_reason`, observações);
5. **manter** os agregados contábeis e operacionais (agendamentos, valores, comissões), que
   deixam de identificar a pessoa;
6. gravar um **tombstone** (`hash do titular` + tenant), para reaplicar a anonimização depois de
   restaurar um backup anterior ao pedido;
7. registrar o evento de auditoria (quem pediu, quando, base).

`appointment_events` é append-only e guarda só IDs e transições. Depois da anonimização em
`customers`, os eventos não identificam mais a pessoa.

## 5. Identificação do solicitante

- **Cliente final:** OTP no telefone cadastrado naquele salão. Sem OTP, o pedido segue pelo
  salão, que confere presencialmente.
- **Equipe e donos:** sessão autenticada + step-up (reautenticação recente).
- Nunca entregar dados a quem só informou nome ou telefone. A resposta é neutra ("se houver
  dados, enviaremos ao número cadastrado"), o que evita enumeração.

## 6. Testes obrigatórios

- A exportação contém **todos** os dados do titular naquele tenant e **nada** de outro titular
  ou de outro tenant (inclusive um titular com o mesmo telefone em outro salão).
- A anonimização remove os dados de todas as tabelas e do bucket, grava o tombstone e mantém
  os agregados.
- Restaurar um backup e reaplicar os tombstones devolve o estado anonimizado.
- A revogação de consentimento impede envios de marketing a partir daquele instante.
- O pedido de um tenant não afeta o mesmo telefone em outro tenant.

## Referências

- LGPD, arts. 16, 18, 19 e 20: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm
