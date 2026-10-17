# Retenção e eliminação

Princípio da necessidade (art. 6º, III): guardar só pelo tempo necessário à finalidade, e
eliminar ao fim do tratamento, salvo as hipóteses de conservação do art. 16. Os prazos abaixo
são **propostas, a validar com jurídico e com o contador**. Nada desta página está automatizado
ainda.

## Prazos

| Dado | Prazo proposto | Fundamento |
|---|---|---|
| Registros de acesso a aplicações (IP + data e hora, por usuário) | **6 meses**, e não mais sem motivo | Marco Civil, art. 15 |
| Logs de segurança e auditoria detalhados | 12 meses, depois só agregados | investigação de incidentes; legítimo interesse (ASVS V16) |
| Registro de incidentes de segurança | **no mínimo 5 anos** | Res. CD/ANPD nº 15/2024 (fonte secundária) |
| Dados do cliente final (`customers` e histórico) | enquanto houver relação. Padrão: **anonimizar após 24 meses sem agendamento**, configurável pelo salão (controlador) | necessidade (art. 6º, III) |
| Anamnese, ficha técnica e fotos | até a revogação do consentimento ou o fim da relação, o que vier primeiro | art. 11, I; finalidade |
| Consentimentos (prova de coleta e revogação) | enquanto o tratamento existir + o prazo prescricional aplicável (definir com o jurídico) | prova (art. 8º, § 2º) |
| `appointment_events` (auditoria) | junto com o tenant. A anonimização do cliente desvincula a pessoa | prova de operações; append-only |
| Faturamento da assinatura do SaaS | 5 anos (**não verificado**; confirmar com o contador) | obrigação fiscal |
| Pagamentos do sinal (Pix) | prazo fiscal do salão (confirmar com o contador) | obrigação fiscal do controlador |
| OTP e tokens de verificação | minutos (TTL do OTP: 5 min) | — |
| Chaves de idempotência | 24 h | técnico |
| Eventos de webhook recebidos | 30 dias depois de processados | depuração e reconciliação |
| Jobs concluídos do pg-boss | 7 dias | técnico |
| Tenant encerrado | exportação disponível por **30 dias**; eliminação em até **90 dias**, inclusive o ciclo de backups e PITR | art. 16 + contrato ([checklist](checklist-contratual.md)) |

## Mecanismos [planejado]

- **Jobs diários de retenção** (fila `lgpd.retention`, [ADR-0005](../adr/0005-fila-pg-boss.md)),
  **por tenant** e com `withTenant`, com métricas de linhas anonimizadas ou eliminadas por
  execução.
- **Anonimização** do cliente pela mesma função usada no direito de eliminação
  ([direitos do titular](direitos-do-titular.md#4-anonimização-do-cliente)).
- **Encerramento de tenant:** procedimento privilegiado dedicado (papel e função próprios,
  nunca no caminho de requisição) que:
  1. exporta;
  2. aguarda o prazo;
  3. elimina as linhas. `appointment_events` bloqueia `DELETE` por trigger, então o
     procedimento precisa de uma exceção controlada e auditada;
  4. destrói a chave de cifra do tenant (crypto-shredding), o que cobre os campos cifrados
     nos backups.
- **Backups:** retenção do PITR do provedor alinhada ao prazo de eliminação. Ao restaurar,
  reaplicar os **tombstones** de anonimização. Restauração testada a cada trimestre.
- **Logs:** a retenção de logs do provedor (Vercel) e do Sentry é configurada no próprio
  serviço, de acordo com a tabela acima.

## Fora do escopo de eliminação automática

- Dados que o salão precisa guardar por obrigação legal (fiscal, trabalhista): o salão indica,
  e o dado fica **bloqueado** (sem uso operacional) até o fim do prazo.
- Dados já anonimizados de forma irreversível, que deixam de ser dado pessoal (art. 12).
