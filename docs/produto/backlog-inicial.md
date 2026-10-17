# Backlog inicial

Épicos e histórias para as próximas iterações, na ordem do [roadmap](mvp-e-roadmap.md). Toda
história segue a [checklist de critérios de aceite](../qa/criterios-de-aceite.md) e a
Definition of Done do [CLAUDE.md](../../CLAUDE.md). As colunas trazem só os critérios
específicos de cada história.

- **Prioridade:** **P0** é necessário para o MVP; **P1** é desejável no MVP; **P2** fica para
  depois do MVP.
- **Threat model** ([como fazer](../seguranca/threat-models/README.md)) obrigatório antes de
  E1, E4, E5, E6 e E8.

## E1. Autenticação e organizações

Iteração 1. Decisão em [ADR-0004](../adr/0004-autenticacao-better-auth.md).

| ID | História | P | Critérios específicos |
|---|---|---|---|
| E1.1 | Como **dono**, quero criar minha conta com e-mail e senha, para começar o período de teste | P0 | senha de 12 a 128 caracteres; HIBP; e-mail verificado antes do acesso; resposta igual para e-mail existente ou não (sem enumeração); Turnstile; rate limit por IP e por conta |
| E1.2 | Como **membro da equipe**, quero configurar TOTP ou passkey, para proteger o acesso aos dados dos clientes | P0 | sem segundo fator verificado, só a tela de configuração; backup codes cifrados; `trustDevice` desligado ou ≤ 7 dias |
| E1.3 | Como **dono**, quero criar meu salão, para ter um espaço isolado | P0 | organização do Better Auth com o mesmo ID de `app.tenants`; slug único validado; o dono vira `owner` |
| E1.4 | Como **dono**, quero convidar profissionais e recepção por e-mail com um papel, para que trabalhem na agenda | P0 | convite só aceito com e-mail verificado e igual ao do convite; expira; papel `admin` ou `member`; auditado |
| E1.5 | Como **dono**, quero remover um membro, para cortar o acesso de quem saiu | P0 | sessões do membro revogadas na hora; tentativa de acesso posterior recebe 401 |
| E1.6 | Como **membro**, quero recuperar a senha sem perder a proteção do segundo fator | P0 | o reset não cria sessão; o login seguinte exige o segundo fator; as outras sessões são revogadas |
| E1.7 | Como **membro**, quero ver e encerrar minhas sessões ativas | P1 | lista com dispositivo e data; encerrar uma ou todas as outras |
| E1.8 | Como **membro que perdeu o TOTP**, quero recuperar o acesso com segurança | P1 | backup code de uso único; sem backup code, processo assistido com espera e notificação a todos os owners |
| E1.9 | (técnica) Camada de autorização | P0 | `tenantAction`/`ownerAction` (sessão → membership → papel → MFA → `withTenant`); `server-only`; **matriz de autorização com meta-teste** "toda rota e action tem entrada"; 404 para recurso de outro tenant; inatividade e tempo absoluto por papel |
| E1.10 | (técnica) Infraestrutura de autenticação | P0 | schema `auth` + papel `app_auth`; `app_user` só com SELECT em membros e organizações; E2E que confere todos os `Set-Cookie` (`__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, sem `Domain`); `cookieCache` desligado |

## E2. Cadastro do salão

Iteração 2.

| ID | História | P | Critérios específicos |
|---|---|---|---|
| E2.1 | Como **dono**, quero cadastrar uma unidade com endereço e fuso, para que a agenda mostre a hora certa | P0 | seletor com as 16 zonas IANA do Brasil, padrão `America/Sao_Paulo`; nunca offset fixo; grade, antecedência mínima e horizonte com os padrões do banco |
| E2.2 | Como **dono**, quero cadastrar serviços a partir de modelos do meu segmento, para começar rápido | P0 | modelos para barbearia, salão e unhas; duração, fases (trabalho e pausa), buffers, preço em centavos e comissão; validação igual à do banco |
| E2.3 | Como **dono**, quero cadastrar profissionais com vínculo e comissão padrão | P0 | vínculo `owner`, `employee`, `partner` ou `freelancer`; comissão e vínculo visíveis só para dono e gerência |
| E2.4 | Como **dono**, quero definir a jornada semanal de cada profissional, com almoço | P0 | dois turnos no mesmo dia; vigência; o banco recusa sobreposição com erro claro; prévia dos horários gerados pelo motor |
| E2.5 | Como **dono**, quero preço, duração ou comissão diferentes por profissional | P1 | override em `staff_services` com precedência documentada |
| E2.6 | Como **recepção**, quero registrar folgas, férias e bloqueios | P0 | `kind` obrigatório; aviso para não detalhar motivo de saúde na observação |
| E2.7 | Como **dono**, quero um onboarding guiado de até 10 minutos, com link público pronto | P1 | checklist (Instagram, Perfil da Empresa no Google, WhatsApp); métrica de ativação |
| E2.8 | Como **dono**, quero cadastrar feriados e horários especiais da unidade | P2 | data local; padrão "aberto" com alerta |

## E3. Agenda da equipe

Iteração 3.

| ID | História | P | Critérios específicos |
|---|---|---|---|
| E3.1 | Como **recepção**, quero ver a agenda do dia e da semana por profissional no celular | P0 | horários no fuso da unidade; pausas visíveis; mobile-first; teclado e leitor de tela |
| E3.2 | Como **recepção**, quero criar um agendamento para um cliente novo ou existente | P0 | origem `staff` ou `walk_in`; o motor sugere horários; a equipe pode ignorar a antecedência mínima; `23P01` vira 409 com mensagem clara e alternativas |
| E3.3 | Como **recepção**, quero mover um agendamento arrastando | P0 | lock otimista (`version`): conflito mostra "alguém alterou, recarregue" e nada é salvo; colisão é recusada pelo banco |
| E3.4 | Como **recepção**, quero marcar chegada, atendimento, conclusão, cancelamento e não comparecimento | P0 | só as transições da máquina de estados; ator registrado em `appointment_events`; cancelar libera o horário na hora |
| E3.5 | Como **recepção**, quero encaixar um cliente na pausa de uma coloração | P1 | o motor oferece a pausa; o `EXCLUDE` garante |
| E3.6 | Como **dono**, quero ver o histórico de alterações de um agendamento | P1 | lista de `appointment_events` com ator e horário local |
| E3.7 | Como **dono**, quero autorizar um encaixe sobreposto excepcional | P2 | decidir o desenho (bypass explícito e auditado do `EXCLUDE`) antes de implementar |

## E4. Página pública de agendamento

Iteração 4.

| ID | História | P | Critérios específicos |
|---|---|---|---|
| E4.1 | Como **cliente**, quero abrir o link do salão e ver serviços e profissionais disponíveis | P0 | `slug → tenant` por função dedicada que devolve só o necessário; só serviços e profissionais agendáveis online; nenhum dado de outros clientes |
| E4.2 | Como **cliente**, quero escolher dia e horário | P0 | horários do motor no fuso da **unidade** (não do aparelho), com o fuso exibido quando diferir; offset visível em rótulo repetido; cache curto por unidade e data |
| E4.3 | Como **cliente**, quero confirmar com nome e celular, sem criar senha | P0 | coleta mínima; aceite do aviso de privacidade (versão registrada); opt-in de WhatsApp separado do marketing; `Idempotency-Key`; corrida perdida vira 409 + 3 alternativas |
| E4.4 | Como **dono**, quero exigir verificação por código no WhatsApp para novos clientes | P1 | template de autenticação; Turnstile antes do envio; limites por número, IP, tenant e dia; falha fechada sem Redis; resposta neutra |
| E4.5 | Como **cliente**, quero remarcar ou cancelar pelo link recebido | P0 | token aleatório de 32 bytes com hash e expiração, trocado por cookie; `no-referrer`; janela de cancelamento calculada no servidor; link alheio ou expirado responde 404 |
| E4.6 | Como **salão**, quero proteção contra robôs que seguram horários | P0 | rate limit por IP e slug; limite de agendamentos pendentes por telefone e por tenant; hold com TTL |
| E4.7 | Como **cliente**, quero instalar a página do salão como app | P2 | PWA com a marca do salão |

## E5. Lembretes por WhatsApp

Iteração 5. Decisões em [ADR-0005](../adr/0005-fila-pg-boss.md) e
[integrações](../dominio/integracoes.md#1-whatsapp-business-platform-cloud-api).

| ID | História | P | Critérios específicos |
|---|---|---|---|
| E5.1 | (técnica) Worker com pg-boss | P0 | Fly `gru`; `app_worker`; enfileiramento na mesma transação (rollback desfaz o job); payload só com IDs; job sem tenant rejeitado; DLQ e alerta |
| E5.2 | Como **cliente**, quero receber a confirmação no WhatsApp | P0 | template utility; `dedupe_key`; só com opt-in |
| E5.3 | Como **cliente**, quero um lembrete 24 h antes com botões "Confirmo" e "Preciso remarcar" | P0 | `singletonKey` por agendamento e offset; remarcar recria o job; webhook da Meta com assinatura verificada registra a confirmação de presença |
| E5.4 | Como **recepção**, quero ver quem não respondeu ao lembrete | P1 | alerta "ligar" na agenda |
| E5.5 | Como **recepção**, quero enviar a mensagem pelo meu WhatsApp quando o automático não estiver disponível | P0 | link `wa.me` com texto pronto, sem custo |
| E5.6 | Como **plataforma**, quero controlar o custo de mensagens por salão | P1 | franquia por plano, orçamento diário com corte, métrica de custo por agendamento |
| E5.7 | (técnica) Jobs de expiração de hold e de no-show | P0 | expira `pending` vencido a cada minuto (`SKIP LOCKED`); no-show opcional por salão; por tenant |

## E6. Sinal via Pix

Iteração 6. Fluxo em [modelo, seção 6](../dominio/modelo.md#6-holds-e-sinal-via-pix).

| ID | História | P | Critérios específicos |
|---|---|---|---|
| E6.1 | Como **dono**, quero conectar a conta Mercado Pago do salão | P0 | OAuth por vendedor; token cifrado por tenant; o dinheiro cai na conta do salão (sem custódia) |
| E6.2 | Como **dono**, quero exigir sinal em serviços ou clientes específicos | P0 | fixo ou percentual; política de cancelamento exibida e aceita antes do pagamento; o sinal abate do total |
| E6.3 | Como **cliente**, quero pagar o sinal por Pix e ter o horário garantido | P0 | `pending` com hold; QR com expiração ≥ hold; confirmação só depois da reconsulta ao PSP |
| E6.4 | Como **plataforma**, quero tratar o Pix pago depois do prazo | P0 | `expired → confirmed` se o horário estiver livre; senão devolução automática + 3 alternativas |
| E6.5 | Como **cliente**, quero o sinal de volta quando o salão cancelar ou quando eu cancelar dentro da janela | P0 | devolução por API; idempotente; auditada |
| E6.6 | (técnica) Webhooks de pagamento | P0 | assinatura `x-signature` com comparação em tempo constante; deduplicação por ID do evento; replay e valor divergente testados |

## E7. Clientes, caixa, comissões e relatórios

Iteração 7.

| ID | História | P | Critérios específicos |
|---|---|---|---|
| E7.1 | Como **recepção**, quero buscar e ver o histórico de um cliente | P0 | busca com limite de resultados e de taxa; DTO por papel |
| E7.2 | Como **dono**, quero importar clientes de uma planilha | P1 | CSV validado; telefone normalizado para E.164; duplicados por tenant |
| E7.3 | Como **recepção**, quero registrar o pagamento no fechamento | P0 | dinheiro, Pix, cartão ou outro; desconto e gorjeta; abate o sinal |
| E7.4 | Como **profissional**, quero ver o extrato das minhas comissões | P0 | snapshot por item; lançamento idempotente; "por que este valor"; cota-parte para parceiro |
| E7.5 | Como **dono**, quero relatórios de faturamento, no-show, ocupação e % online | P0 | definições da [seção de métricas](mvp-e-roadmap.md#5-métricas); mês no fuso da unidade |

## E8. LGPD do titular

Iteração 7. Requisitos em [direitos do titular](../lgpd/direitos-do-titular.md).

| ID | História | P | Critérios específicos |
|---|---|---|---|
| E8.1 | Como **cliente**, quero baixar os dados que o salão tem sobre mim | P0 | autenticação por OTP; só aquele tenant; JSON e CSV; link expira em 24 h |
| E8.2 | Como **cliente**, quero pedir a exclusão dos meus dados | P0 | fila do salão com SLA; anonimização com tombstone; agregados mantidos |
| E8.3 | Como **cliente**, quero retirar meu consentimento de marketing | P0 | registro append-only; efeito imediato |
| E8.4 | Como **dono**, quero exportar todos os dados do meu salão | P0 | só owner, com step-up; assíncrono; auditado |
| E8.5 | (técnica) Retenção automática | P1 | job diário por tenant (24 meses sem agendamento → anonimizar, configurável) |

## E9. Assinatura do SaaS

Iteração 7.

| ID | História | P | Critérios específicos |
|---|---|---|---|
| E9.1 | Como **dono**, quero testar grátis e depois assinar | P0 | trial; cobrança em BRL por profissional ativo |
| E9.2 | Como **dono**, quero cancelar a assinatura sozinho, sem multa | P0 | efeito imediato; e-mail de confirmação; **teste automatizado de que nenhuma cobrança acontece depois** |

## Transversal (antes ou durante o MVP)

| ID | Item | P |
|---|---|---|
| T1 | Deploy: Vercel `gru1`, Neon `aws-sa-east-1`, Fly `gru`; migrações por Actions com environment protegido e OIDC ([ADR-0006](../adr/0006-hospedagem-e-residencia.md)) | P0 |
| T2 | Observabilidade: pino com redaction, Sentry sem PII, eventos de segurança e alertas | P0 |
| T3 | `safeFetch` para toda chamada de saída | P0 |
| T4 | Rate limit (Upstash `sa-east-1`) com falha fechada | P0 |
| T5 | Matriz de autorização HTTP com dois tenants e todos os papéis no E2E | P0 |
| T6 | Testes de RLS e invariantes contra staging com os papéis reais | P1 |
| T7 | Mutation testing (Stryker) noturno no core (ver o bloqueio com o Vitest 5 em [QA](../qa/estrategia.md#8-mutation-testing)) | P2 |
| T8 | Carga com k6 (disponibilidade + disputa de horário quente) | P1 |
