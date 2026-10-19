# Glossário (pt-BR ↔ código)

Linguagem ubíqua do produto. Identificadores de código ficam em **inglês**; UI, documentação e
conversa com o salão, em **pt-BR**. Quando um termo novo surgir, inclua-o aqui no mesmo PR.

Coluna "Onde": **db** = schema `app` de `@salon/db`; **core** = `@salon/scheduling-core`;
**web** = `@salon/web`; **planejado** = ainda não existe no código.

## Organização

| Termo (pt-BR) | Identificador | Onde | Definição |
|---|---|---|---|
| Salão, tenant | `tenants`, `tenantId` / `tenant_id` | db | unidade de isolamento: um negócio cliente do SaaS. Será a `organization` do Better Auth |
| Situação do salão | `tenants.status`: `trial`, `active`, `suspended`, `closed` | db | ciclo de vida comercial (teste, ativo, suspenso, encerrado) |
| Unidade, filial | `locations` | db | endereço físico com **fuso IANA próprio** e regras do agendamento online |
| Slug | `tenants.slug`, `locations.slug` | db | identificador legível na URL pública |
| Dono, gerente/recepção, profissional | `owner`, `admin`, `member` (papéis da organização) | planejado | papéis de acesso no painel |
| Profissional | `staff` | db | quem atende. Pode ou não ter login |
| Nome de exibição | `staff.display_name` | db | nome do profissional na agenda e na página pública |
| Vínculo | `staff.engagement_type`: `owner` (proprietário), `employee` (CLT), `partner` (parceiro, Lei do Salão-Parceiro), `freelancer` (autônomo) | db | define comissão × cota-parte e permissões |
| Agendável online | `staff.bookable_online`, `services.online_bookable` | db | aparece ou não na página pública |

## Catálogo e agenda

| Termo (pt-BR) | Identificador | Onde | Definição |
|---|---|---|---|
| Serviço | `services` | db | o que o salão oferece: nome, duração, preço, comissão |
| Duração | `duration_min` (db) = soma dos `minutes` das fases (core) | db, core | tempo visível ao cliente |
| Fase | `services.phases` / `ServicePhase` com `kind` `work` (trabalho) ou `pause` (pausa) e `minutes` | db, core | partes de um serviço multi-etapa. Na **pausa** (ação da química) o profissional fica livre para outro cliente |
| Buffer (preparo, limpeza) | `buffer_before_min`, `buffer_after_min` | db, core | tempo que ocupa o profissional mas não aparece ao cliente. Pode passar do limite do turno |
| Override por profissional | `staff_services` (`price_cents`, `duration_min`, `commission_bps`) | db | "corte com o dono" custa mais que "com o júnior" |
| Jornada | `working_hours` (`weekday` 1–7 ISO, `start_time`, `end_time`, `valid_from`, `valid_until`) / `WorkShift`, `weeklySchedule` | db, core | horário semanal em **hora de parede** no fuso da unidade. Almoço = dois turnos no mesmo dia |
| Folga, férias, curso, bloqueio | `time_off.kind`: `time_off`, `vacation`, `training`, `blocked` / `timeOff` | db, core | ausência em instantes absolutos (`during`, `tstzrange`) |
| Feriado da unidade | `location_holidays` | planejado | data **local**: fechado ou horário especial |
| Horas extras | `extra_hours` | planejado | abre fora da jornada |
| Recurso (cadeira, lavatório, sala, maca) | `resources` | planejado | capacidade física, opcional |
| Granularidade, grade | `locations.slot_interval_min` / `granularityMinutes` | db, core | espaçamento entre inícios possíveis (5, 10, 15, 20, 30 ou 60 min), contado no relógio local |
| Antecedência mínima | `locations.min_notice_min` / `minNoticeMinutes` | db, core | não agendar "daqui a 10 minutos" (padrão 120 min). A equipe pode ignorar |
| Horizonte (antecedência máxima) | `locations.max_advance_days` / `maxAdvanceMinutes` | db, core | até quando a agenda está aberta (padrão 60 dias) |
| Horário disponível | `AvailableSlot` (`start`, `end`, `localDate`, `localTime`, `utcOffset`) | core | resultado de `computeAvailableSlots` |

## Agendamento

| Termo (pt-BR) | Identificador | Onde | Definição |
|---|---|---|---|
| Agendamento (visita) | `appointments` | db | uma ida do cliente ao salão; pode ter vários serviços e profissionais |
| Item do agendamento | `appointment_items` (`position`, `service_name`, `price_cents`, `commission_bps`, `phases`, `buffer_before_min`, `buffer_after_min`) | db | serviço × profissional com preço, comissão, duração, fases e buffers **congelados** (snapshot). Profissional, horário, duração, fases e buffers são imutáveis |
| Ocupação | `occupancies` (`kind`: `service` ou `buffer`; `active`) / `OccupancySegment`, `staffOccupancySegments` | db, core | intervalo em que o profissional está ocupado, amarrado ao item. Uma linha por fase de trabalho (`service`) e uma por buffer (`buffer`). É o alvo do `EXCLUDE` anti-overbooking. `active` é **derivada do status** |
| Status | `status` / `AppointmentStatus` | db, core | ver a tabela abaixo |
| Origem | `appointments.source`: `online`, `staff`, `walk_in` (chegou sem hora marcada) | db | canal de criação |
| Hold, reserva temporária | `hold_expires_at` | db | prazo de um agendamento `pending` (sinal ou aprovação). Expirado, vira `expired` |
| Sinal | `deposit` | planejado | valor pago via Pix para garantir o horário; **sempre abate** do total |
| Remarcação | `rescheduled_from_id` | db | remarcar cria **outro** agendamento ligado ao original. Mover o horário também é remarcar: visita e item são imutáveis |
| Chave de idempotência | `idempotency_key` (única por tenant) | db | evita agendamento duplicado por reenvio do formulário |
| Versão | `version` | db | lock otimista: todo UPDATE incrementa |
| Evento de auditoria | `appointment_events` (`event_type`: `created`, `status_changed`) | db | trilha append-only escrita por trigger |
| Ator | `actor_type`: `customer`, `staff`, `system`, `unknown`; `actor_id` | db | quem causou a transição (via `withTenant`) |
| Encaixe | `is_overbook` | planejado | bypass explícito e auditado do anti-overbooking: só dono ou gerente/recepção com permissão explícita, com motivo obrigatório de lista fechada registrado em `appointment_events`; nunca pela página pública. Não existe na fundação |
| Lista de espera | `waitlist_entries` | planejado | cliente aguardando vaga |
| Confirmou presença | `client_confirmed_at` | planejado | **atributo**, não status: o cliente tocou "Confirmo" no lembrete |
| Comissão | `commission_bps` (basis points: 1% = 100) | db | parte do **profissional** sobre o item |
| Cota-parte | regime `cota_parte` | planejado | parte retida pelo salão-parceiro (Lei 13.352/2016) |

### Status do agendamento

| pt-BR (UI) | Código | Ocupa a agenda? |
|---|---|---|
| Aguardando (sinal ou aprovação) | `pending` | sim, até o hold expirar |
| Confirmado | `confirmed` | sim |
| Cliente chegou | `checked_in` | sim |
| Em atendimento | `in_service` | sim |
| Concluído | `completed` | sim (histórico) |
| Cancelado pelo cliente | `cancelled_by_customer` | não |
| Cancelado pelo salão | `cancelled_by_salon` | não |
| Não compareceu | `no_show` | não |
| Expirado | `expired` | não |

Os rótulos de UI ficam em [`apps/web/src/lib/appointment-status-labels.ts`](../../apps/web/src/lib/appointment-status-labels.ts),
exaustivos em relação ao core. As transições estão em [modelo.md](modelo.md#3-máquina-de-estados-do-agendamento).

## Clientes

| Termo (pt-BR) | Identificador | Onde | Definição |
|---|---|---|---|
| Cliente (final) | `customers` | db | pessoa atendida pelo salão. Dados do salão (controlador) |
| Celular / WhatsApp | `phone_e164` | db | formato E.164 (`+55…`), único **por salão** |
| Opt-in de WhatsApp | `whatsapp_opt_in_at` | db | aceite para receber mensagens transacionais (exigência da Meta) |
| Consentimento de marketing | `marketing_consent_at` | db | separado do transacional |
| Versão do aviso de privacidade | `privacy_notice_version` | db | o texto que o cliente viu |
| Anonimizado | `anonymized_at` | db | direito de eliminação: sem contato nem consentimentos |
| Ficha técnica, anamnese | `client_records` | planejado | anamnese com saúde é **dado sensível** |

## Tempo

| Termo (pt-BR) | Identificador | Onde | Definição |
|---|---|---|---|
| Instante | `Temporal.Instant`, `timestamptz` | core, db | ponto absoluto na linha do tempo (UTC) |
| Hora de parede (hora local) | `local_starts_at`, `'HH:MM'` (`parseWallTime`, `formatWallTime`) | db, core | o que o relógio da unidade mostra |
| Offset UTC | `local_utc_offset_seconds` / `utcOffset` | db, core | diferença entre a hora de parede e o UTC naquela ocorrência. Distingue a hora repetida do fim do horário de verão |
| Fuso | `timezone` (IANA, ex.: `America/Manaus`) | db, core | sempre o da **unidade**. Nunca offset fixo. No banco e no core, nome `Area/Local` sem dígito: `Etc/UTC`, não `UTC`; `Etc/GMT+3` é recusado |
| Intervalo semiaberto | `[início, fim)`, `tstzrange(..., '[)')`, `Interval` | core, db | atendimentos encostados não colidem |
| Relógio | `Clock` (`systemClock`, `fixedClock`) | core | única fonte de "agora" no domínio |
| Dia local | — | core | pode ter 23 h, 25 h ou outra duração em fusos com horário de verão |

## Segurança e dados

| Termo (pt-BR) | Identificador | Onde | Definição |
|---|---|---|---|
| Contexto de tenant | GUC `app.tenant_id` | db | definido por transação via `withTenant` |
| Porta de acesso | `withTenant(db, tenantId, fn, { actor, readOnly })` | db | única forma de ler ou gravar dado de tenant, em transação READ COMMITTED; o `tx` só vale durante `fn` |
| Papéis do banco | `app_migrator`, `app_user`, `app_worker` (planejado: `app_auth`) | db | dono das tabelas; app web; jobs; autenticação |
| Isolamento | RLS `ENABLE` + `FORCE`, políticas `tenant_isolation` e `app_access` | db | ver [ADR-0002](../adr/0002-isolamento-multi-tenant-rls.md) |
| Erros traduzidos | `SlotUnavailableError` (23P01), `TenantIsolationError` (42501), `InvalidStatusTransitionError`, `IdempotencyKeyConflictError`, `IdentifierConflictError` (23505 na PK: id já usado, possivelmente por outro tenant) | db | erros do banco sem `DETAIL` |
| Transação encerrada | `TransactionClosedError` | db | `tx` usado depois do fim do callback de `withTenant` (bug do chamador) |
| Erro de entrada do domínio | `SchedulingInputError` (com `field`) | core | entrada inválida no motor |
| Erro de transição | `AppointmentTransitionError` (`code`: `transition_not_allowed`, `terminal_status`, `unchanged`, `unknown_status`) | core | transição recusada |
| DAL | camada de acesso a dados do app | planejado | resolve sessão → membership → tenant antes de `withTenant` |
