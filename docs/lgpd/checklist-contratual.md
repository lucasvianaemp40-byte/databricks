# Checklist contratual (DPA, termos e política de privacidade)

> **A validar com jurídico.** Lista de pontos que a engenharia precisa ver refletidos nos
> contratos. Não é minuta. A redação final é do advogado.

A LGPD não prescreve um "DPA" como o art. 28 do GDPR. Mas os arts. 39 (instruções do
controlador), 42 (responsabilidade solidária do operador) e 46 e 47 (segurança) tornam o
contrato o instrumento de prova entre o salão (controlador) e a plataforma (operadora).

## 1. Contrato de operador com o salão (DPA)

- [ ] Objeto, duração, natureza e finalidades do tratamento.
- [ ] Categorias de titulares (clientes finais, equipe) e de dados, inclusive os sensíveis
      opcionais (anamnese, fotos).
- [ ] Tratamento **somente conforme instruções documentadas**: os termos e as configurações
      feitas pelo salão no produto.
- [ ] **Proibição de uso para finalidade própria da plataforma**, salvo dados anonimizados ou
      agregados.
- [ ] Confidencialidade do pessoal da plataforma com acesso aos dados.
- [ ] Anexo técnico de segurança:
  - isolamento por RLS ([ADR-0002](../adr/0002-isolamento-multi-tenant-rls.md));
  - criptografia;
  - controle de acesso;
  - logs;
  - backups;
  - resposta a incidentes.
- [ ] **Suboperadores** (seção 4):
  - lista pública;
  - aviso prévio de mudanças;
  - direito de objeção do salão.
- [ ] Apoio ao controlador:
  - direitos dos titulares (ferramentas de [exportação e anonimização](direitos-do-titular.md));
  - RIPD;
  - fiscalização da ANPD.
- [ ] **Incidente:** a plataforma avisa o salão em **até 24 h** do conhecimento, com os itens do
      art. 48, § 1º, para que o salão cumpra o prazo de 3 dias úteis
      ([resposta a incidentes](../seguranca/resposta-a-incidentes.md)).
- [ ] **Término:**
  - exportação disponível por 30 dias;
  - eliminação em até 90 dias, inclusive backups;
  - certificado de eliminação;
  - conservação só nas hipóteses do art. 16.
- [ ] **Transferência internacional:** cláusulas-padrão contratuais da ANPD (Res. CD/ANPD nº
      19/2024) com cada suboperador fora do Brasil. Para a UE, a adequação recíproca da Res. nº
      32/2026 (fonte secundária).
- [ ] Auditoria: relatórios e questionários; auditoria presencial com aviso prévio.
- [ ] Registro de operações do operador (art. 37) disponível ao controlador.
- [ ] Acesso do suporte da plataforma só com janela concedida pelo dono do salão, registrado
      e visível a ele.

## 2. Termos de uso do SaaS (relação comercial)

- [ ] **Sem fidelidade.** Plano anual só como desconto pré-pago com reembolso pró-rata.
      Cancelamento self-service com efeito imediato e nenhuma cobrança posterior (diferencial,
      ver [posicionamento](../produto/concorrentes-e-posicionamento.md)).
- [ ] Reajuste com aviso de 30 dias.
- [ ] Preço por profissional ativo com agenda no mês.
- [ ] Custo de mensagens: franquia de WhatsApp transacional no plano; marketing como crédito
      pré-pago ([integrações](../dominio/integracoes.md#1-whatsapp-business-platform-cloud-api)).
- [ ] Pix do sinal cai **direto na conta do salão** (OAuth do PSP). A plataforma não custodia
      valores. Confirmar com o jurídico o enquadramento regulatório (instituição de pagamento
      ou subcredenciador).
- [ ] O salão é responsável pelas próprias obrigações: política de cancelamento ao consumidor
      (CDC), fiscal (NFS-e) e trabalhista ou parceria (Lei do Salão-Parceiro). O produto não dá
      parecer jurídico na interface.

## 3. Avisos de privacidade

- [ ] **Aviso da plataforma** (como controladora): contas, cobrança, registros de acesso,
      segurança e antifraude, suboperadores, transferência internacional e encarregado.
- [ ] **Modelo de aviso para o salão** (como controlador dos dados dos clientes), exibido na
      página pública de agendamento, com:
  - finalidades;
  - bases;
  - retenção;
  - direitos e canal do titular;
  - lista de suboperadores.
- [ ] Versão do aviso registrada no aceite (`customers.privacy_notice_version`).
- [ ] **Cookies:** app e página de agendamento só com cookies estritamente necessários (sessão,
      estado, desafio WebAuthn), sem banner. Site de marketing com analytics precisa de banner,
      com "rejeitar" tão fácil quanto "aceitar". O guia de cookies da ANPD (2022) não foi lido
      nesta pesquisa.
- [ ] Política de cancelamento e de sinal exibida **antes** do pagamento, com aceite registrado.
      O Idec considera abusiva a taxa para agendar que não é abatida do serviço (fonte
      secundária). O sinal sempre abate do total.

## 4. Suboperadores (lista inicial proposta)

| Suboperador | Finalidade | Região dos dados | Transferência internacional? |
|---|---|---|---|
| Vercel | hospedagem do app | funções em `gru1`; logs e plataforma a confirmar | sim (empresa dos EUA): cláusulas-padrão |
| Neon | PostgreSQL | `aws-sa-east-1` | a confirmar (suporte e telemetria) |
| Fly.io | worker | `gru` | a confirmar |
| Upstash | rate limit | `sa-east-1` | a confirmar |
| Meta (WhatsApp Cloud API) | mensagens | fora do Brasil | sim: cláusulas-padrão |
| Mercado Pago | Pix do sinal | Brasil | não (o PSP é controlador do que lhe cabe) |
| Provedor de e-mail (a definir) | e-mails transacionais | a definir | provável |
| Sentry | erros, sem PII | preferir UE | sim: UE com adequação (Res. 32/2026) ou cláusulas-padrão |
| Cloudflare (Turnstile) | anti-bot | global | sim |

## 5. Outros instrumentos

- [ ] **Ato de designação do encarregado** da plataforma, com substituto (Res. CD/ANPD nº
      18/2024). Identidade e contato publicados no site.
- [ ] **RIPD** da anamnese e fotos ([dados sensíveis](dados-sensiveis.md)).
- [ ] **Registro das operações** (art. 37): a plataforma como controladora e como operadora.
- [ ] **Contrato com fornecedores:** DPA e cláusulas-padrão da ANPD (o prazo de adequação
      terminou em 23/08/2025).
- [ ] Contrato de parceria **salão × profissional** (Lei 13.352/2016): é do salão, não da
      plataforma. O produto só registra as datas de assinatura e homologação (fase 3).
