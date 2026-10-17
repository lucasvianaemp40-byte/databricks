# @salon/scheduling-core

Núcleo de domínio do agendamento: disponibilidade, regras de tempo e ciclo de vida do
agendamento. **Puro**: sem I/O, sem relógio global, sem aleatoriedade, sem framework. Tudo o
que vem de fora (agora, ocupações, jornada, fuso) entra por parâmetro, o que torna cada
resultado reproduzível e testável por propriedades.

Pacote interno do monorepo: exporta o fonte TypeScript (`src/index.ts`); o Next.js o
transpila via `transpilePackages`.

## O que tem aqui

| Módulo | Para quê |
|---|---|
| `time/clock.ts` | `Clock` injetado (`now(): Temporal.Instant`), `systemClock` (produção, único ponto que lê o relógio real) e `fixedClock` (testes). |
| `time/intervals.ts` | Álgebra imutável de intervalos semiabertos `[start, end)` em `Temporal.Instant`: `mergeIntervals`, `intersectIntervals`, `subtractIntervals`, `sortIntervals`, `overlaps`, `containsInterval`. |
| `time/wall-time.ts` | Hora de parede `'HH:MM'` (e `'24:00'` como fim de turno) ↔ minutos do dia. |
| `time/local-day.ts` | Dia local num fuso IANA como trecho da linha do tempo, com os trechos de offset constante; `wallTimeToInstant` com regra de horário de verão explícita. |
| `availability/service.ts` | Serviço com fases (trabalho/pausa) e buffers; pegada na agenda do profissional; `staffBusyIntervals` (alocações a gravar na reserva). |
| `availability/compute-available-slots.ts` | `computeAvailableSlots`: horários livres de um profissional para um serviço. |
| `appointment/appointment-status.ts` | Máquina de estados do agendamento com erro tipado. |

## Uso

```ts
import { Temporal } from 'temporal-polyfill';
import { computeAvailableSlots, singlePhaseService, systemClock } from '@salon/scheduling-core';

const slots = computeAvailableSlots({
  timeZone: 'America/Sao_Paulo', // fuso da UNIDADE, nunca o do servidor ou do navegador
  from: Temporal.PlainDate.from('2026-11-03'),
  to: Temporal.PlainDate.from('2026-11-09'),
  weeklySchedule: [
    { isoWeekday: 2, start: '09:00', end: '12:00' }, // almoço = dois turnos
    { isoWeekday: 2, start: '13:00', end: '18:00' },
  ],
  service: singlePhaseService(30, { after: 10 }), // 30 min + 10 min de limpeza
  busy: [], // alocações ativas do profissional (já com os buffers delas)
  timeOff: [], // folgas e bloqueios
  granularityMinutes: 15,
  minNoticeMinutes: 120,
  maxAdvanceMinutes: 60 * 1440, // max_advance_days x 1440
  clock: systemClock,
});
// [{ start: Instant, end: Instant, localDate: '2026-11-03', localTime: '09:00', utcOffset: '-03:00' }, ...]
```

Mapeamento a partir do banco (`@salon/db`; detalhes em
[`docs/dominio/modelo.md`](../../docs/dominio/modelo.md)): `working_hours` (`valid_from`/`valid_until`
→ `validFrom`/`validUntil`) → `weeklySchedule`; `occupancies` com `active = true` → `busy`;
`time_off` → `timeOff`; `services.phases` (`kind` `work`/`pause`) + buffers → `service`;
`locations.timezone` → `timeZone`, `slot_interval_min` → `granularityMinutes`,
`min_notice_min` → `minNoticeMinutes`, `max_advance_days` × 1440 → `maxAdvanceMinutes`.

## Regras de tempo (decisões)

- **Instantes** são `Temporal.Instant` (UTC). **Intervalos** são semiabertos `[start, end)`,
  como `tstzrange(..., '[)')`: atendimentos encostados não colidem.
- **Fuso** é o IANA da unidade (`America/Manaus`, `America/Noronha`...). Offset fixo
  (`-03:00`) é recusado: o horário de verão pode voltar (Decreto 9.772/2019 o extinguiu, mas
  é decisão anual do governo) e o fuso precisa seguir o tzdata.
- **Hora de parede → instante** (limites de turno e `wallTimeToInstant`): o resultado é o
  **primeiro instante do dia local em que o relógio marca um horário ≥ o pedido**.
  - horário comum: o instante único;
  - horário **ambíguo** (fim do horário de verão, a hora se repete): a **primeira** ocorrência;
  - horário **inexistente** (início do horário de verão, o relógio pula): o **instante da
    transição**;
  - `24:00`: o início do dia local seguinte.

  A regra é monotônica: um turno com início < fim nunca vira intervalo invertido. A
  desambiguação `'compatible'` do Temporal não tem essa garantia (numa lacuna ela empurra
  02:30 para 03:30, então `[02:30, 03:15)` ficaria ao contrário).

  **Atenção, banco:** `timestamp AT TIME ZONE` do Postgres usa outra regra (verificado no PG
  16.15): hora ambígua vira a **segunda** ocorrência (`2026-11-01 01:30` em Nova York →
  06:30Z, aqui 05:30Z) e hora inexistente é **empurrada para frente** (`2026-03-08 02:30` →
  07:30Z, aqui 07:00Z). Não reconverta hora de parede no SQL esperando o mesmo instante: grave
  o instante calculado aqui junto com hora local, offset e fuso.
- **Grade** no relógio local: inícios em 00:00 + k × granularidade, contados no relógio da
  unidade, não em tempo decorrido. Com horário de verão de 30 min (Lord Howe) e grade de
  60 min, os rótulos continuam em hora cheia. Rótulos inexistentes não geram horário. Rótulos
  repetidos geram **dois** horários, distinguidos por `utcOffset`; a UI deve mostrar o offset
  nesse caso, e a reserva deve gravar hora local, offset e fuso.
- **Dia local** pode ter 23 h, 25 h, 23,5 h ou 0 h (Pacific/Apia pulou 2011-12-30). Turno que
  vira a meia-noite está fora do escopo: um atendimento nunca atravessa a meia-noite local.
- **Buffers** (preparo/limpeza) ocupam o profissional e nunca podem colidir com ocupação ou
  bloqueio, mas **podem** passar do limite do turno (preparo antes de abrir, limpeza depois
  de fechar). O atendimento visível (fases, inclusive pausas) precisa caber inteiro no turno.
  Consequência: limpeza pode invadir o almoço modelado como intervalo entre dois turnos, mas
  não o almoço modelado como bloqueio.
- **Pausa** (ação do produto) libera o profissional: outro cliente cabe nela.
- **Antecedência e horizonte** são inclusivos: `agora + antecedência ≤ início ≤ agora +
  horizonte`, com "agora" lido **uma vez** do `Clock`. O horizonte é duração absoluta
  (dias × 1440 min), não "até o fim do dia local".
- **Precisão**: comparações exatas até o nanossegundo. Internamente o motor usa
  milissegundos inteiros (os candidatos caem em minutos inteiros), arredondando bordas de
  ocupação para fora e da região permitida para dentro, o que não muda nenhuma decisão.
- **Desempenho**: o Temporal entra uma vez por dia (início do dia e transições); o resto é
  aritmética inteira com busca binária nas ocupações. Medido neste container: 60 dias, grade
  de 5 min, 400 ocupações → ~32 ms por chamada (2.424 horários).
- **Limites**: até 366 datas por consulta (`MAX_RANGE_DAYS`), granularidade de 1 a 1440 min,
  antecedência e horizonte até 2 anos, serviço de até 24 h. Entrada inválida lança
  `SchedulingInputError` com o campo ofensor (`field`).

## Máquina de estados do agendamento

| De | Para |
|---|---|
| (criação) | `pending` (sinal ou aprovação) ou `confirmed` |
| `pending` | `confirmed`, `cancelled_by_customer`, `cancelled_by_salon`, `expired` |
| `confirmed` | `checked_in`, `in_service`, `completed`, `cancelled_by_customer`, `cancelled_by_salon`, `no_show` |
| `checked_in` | `in_service`, `completed`, `cancelled_by_customer`, `cancelled_by_salon` |
| `in_service` | `completed` |
| `no_show` | `checked_in` (correção: chegou atrasado) |
| `expired` | `confirmed` (Pix pago depois do hold; o EXCLUDE do banco re-checa) |
| `completed`, `cancelled_*` | terminais (remarcar = novo agendamento) |

`transitionAppointmentStatus(from, to)` devolve `{ ok: true, from, to }` ou
`{ ok: false, error }`, onde `error` é um `AppointmentTransitionError` (um `Error` de verdade)
com `code`: `transition_not_allowed`, `terminal_status`, `unchanged` (mesmo status: o chamador
decide se é idempotente) ou `unknown_status`. `occupiesSchedule(status)` diz se as alocações
continuam ativas (falso para cancelados, `no_show` e `expired`).

A tabela espelha o guard de status do banco: mantenha os dois em sincronia. Quem pode disparar
cada transição (cliente, equipe, sistema) é autorização e entra com a autenticação.

## Testes

```bash
pnpm --filter @salon/scheduling-core test          # exemplos + propriedades, com cobertura
FC_NUM_RUNS=2000 pnpm --filter @salon/scheduling-core test   # mais casos (noturno)
FC_SEED=<seed> FC_PATH=<path> pnpm --filter @salon/scheduling-core test   # reproduz falha
TZ=Pacific/Kiritimati pnpm --filter @salon/scheduling-core test   # prova independência do fuso da máquina
```

- `*.test.ts`: exemplos que documentam o comportamento (inclusive cada caso de horário de
  verão). `*.prop.test.ts`: propriedades com fast-check (tag `property`).
- Cobertura mínima por arquivo: linhas 95%, ramos 90%, funções 95%, instruções 95%.
- O oráculo de força bruta (`test/oracles/`) usa só Temporal e nanossegundos em `bigint`,
  independente da aritmética do motor. Os arbitrários (`test/arbitraries/`) puxam datas das
  transições reais do tzdata em 14 fusos (Brasil, Nova York, Santiago, Lisboa, Londres, Lord
  Howe, Chatham, Kathmandu, Kiritimati, Apia, UTC).
- Propriedades de `computeAvailableSlots`: P1 dentro da jornada; P2 sem colisão com ocupação
  ou bloqueio (fases e buffers); P3 ordem, unicidade e duração; P4 antecedência e horizonte;
  P5 reservas sequenciais nunca se sobrepõem; P6 monotonicidade ao surgir ocupação; P7 oráculo
  minuto a minuto; P8 rótulo, offset e ida e volta pelo Temporal; P9 igualdade com o oráculo
  de força bruta (completude e correção); P10 grade local; P11 determinismo e entrada
  intacta; P12 pausa livre; P13 translação (fuso fixo ≡ UTC deslocado); P14 monotonicidade em
  antecedência e horizonte; P15 indiferença à ordem e à origem das ocupações.
- `test/lint-rules.test.ts` prova que as regras de pureza disparam (relógio, aleatoriedade,
  `Date`, formatação local, I/O).

## Fora do escopo (próximas iterações)

- "Qualquer profissional" (união por horário) e serviços em sequência com profissionais
  diferentes: o chamador combina chamadas por profissional por enquanto.
- Recursos físicos (cadeira, lavatório), feriados da unidade (`location_holidays`) e horas
  extras (`extra_hours`) somando à jornada.
- Turnos que atravessam a meia-noite.
- Regras de autorização por ator nas transições de status.
- Node 26 traz Temporal nativo: trocar o import de `temporal-polyfill` pelo global num só
  lugar quando o runtime de produção migrar.
