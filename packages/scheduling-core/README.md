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
| `availability/service.ts` | Serviço com fases (trabalho/pausa) e buffers; pegada na agenda do profissional; `staffBusyIntervals` (trechos ocupados unidos, o que o motor testa) e `staffOccupancySegments` (linhas de `occupancies` a gravar na reserva, com `kind`). |
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
  busy: [], // ocupações ativas do profissional em TODAS as unidades (já com os buffers)
  timeOff: [], // folgas e bloqueios
  granularityMinutes: 15,
  minNoticeMinutes: 120,
  maxAdvanceMinutes: 60 * 1440, // max_advance_days x 1440
  clock: systemClock,
});
// [{ start: Instant, end: Instant, localDate: '2026-11-03', localTime: '09:00', utcOffset: '-03:00' }, ...]
```

Mapeamento a partir do banco (`@salon/db`; detalhes em
[`docs/dominio/modelo.md`](../../docs/dominio/modelo.md)):

| Entrada | Origem |
|---|---|
| `weeklySchedule` | `working_hours` do profissional **na unidade consultada** (`WHERE location_id = :locationId`) com vigência que cruza `[from, to]`; `valid_from`/`valid_until` → `validFrom`/`validUntil` |
| `busy` | `occupancies` com `active = true` do profissional **em todas as unidades** |
| `timeOff` | `time_off` do profissional (e bloqueios da unidade) |
| `service` | `services.phases` (`kind` `work`/`pause`) + buffers |
| `timeZone`, `granularityMinutes` | `locations.timezone`, `slot_interval_min` |
| `minNoticeMinutes`, `maxAdvanceMinutes` | `min_notice_min`, `max_advance_days` × 1440 |

O motor **une turnos encostados**. Passar faixas de outra unidade (o banco aceita 09–12 na
unidade A e 12–18 na B para o mesmo profissional) faria um atendimento começar numa unidade e
terminar na outra. Já as ocupações vêm de todas as unidades: o profissional não está em dois
lugares ao mesmo tempo.

**Gravar a reserva** (transação de reserva [planejado]; o schema e as garantias do banco já
existem, ver [`packages/db/README.md`](../db/README.md)). Do horário escolhido (`slot`) e do
serviço lido NA transação:

| Linha | Colunas | Origem no core |
|---|---|---|
| `appointments` | `starts_at`, `ends_at` | `slot.start`, `slot.end` (instantes) |
| | `local_starts_at` | `` `${slot.localDate} ${slot.localTime}:00` `` (hora de parede, sem fuso) |
| | `local_utc_offset_seconds` | `slot.utcOffset` em segundos (`'-03:00'` → `-10800`; ou `slot.start.toZonedDateTimeISO(timeZone).offsetNanoseconds / 1e9`) |
| | `timezone` | o mesmo `timeZone` passado ao motor (`locations.timezone`) |
| `appointment_items` | `duration_min`, `phases`, `buffer_before_min`, `buffer_after_min` | o `ServiceDefinition` usado no cálculo, **congelado** no item (snapshot do catálogo) |
| | `starts_at`, `ends_at` | janela visível: `slot.start`, `slot.end` |
| `occupancies` | `kind`, `starts_at`, `ends_at` | `staffOccupancySegments(slot.start, service)`: uma linha por trecho |

- **Hora local + offset + fuso**, não só o instante: o offset distingue as duas ocorrências da
  hora repetida no fim do horário de verão (01:30 −04:00 e 01:30 −05:00 em Nova York,
  2026-11-01) e permite recalcular o instante se a regra do fuso mudar. O banco confere
  hora local = instante + offset (CHECK `appointments_local_time_coherent`, sem tzdata) e
  exige que `timezone` seja o da unidade.
- **Fases congeladas:** o item guarda as fases e os buffers do serviço no momento da reserva.
  Mudar o catálogo depois não mexe na agenda: qualquer recálculo (ocupações, remarcação)
  parte de `appointment_items.phases` e dos buffers do item, nunca de `services`.
- **Ocupações por fase:** `staffOccupancySegments(start, service)` devolve as linhas de
  `occupancies` em ordem cronológica e sem unir trechos encostados: o preparo
  (`kind = 'buffer'`), cada fase de trabalho (`kind = 'service'`) e a limpeza
  (`kind = 'buffer'`). Pausas e buffers de 0 min não geram linha (na pausa o profissional
  fica livre). A união das linhas é exatamente `staffBusyIntervals(start, service)`, o que o
  motor de disponibilidade testa. `OCCUPANCY_KINDS` espelha o CHECK `occupancies_kind_valid`.
  No COMMIT, o banco exige que as ocupações `service` ativas cubram cada fase `work`
  congelada no item; não grave `staffBusyIntervals` (une buffer e trabalho num trecho só).

## Regras de tempo (decisões)

- **Instantes** são `Temporal.Instant` (UTC). **Intervalos** são semiabertos `[start, end)`,
  como `tstzrange(..., '[)')`: atendimentos encostados não colidem.
- **Fuso** é o IANA da unidade (`America/Manaus`, `America/Noronha`...). Offset fixo
  (`-03:00`) é recusado: o horário de verão pode voltar (Decreto 9.772/2019 o extinguiu, mas
  é decisão anual do governo) e o fuso precisa seguir o tzdata. `assertIanaTimeZone` usa a
  mesma regra do CHECK do banco (`app_private.is_valid_iana_timezone`, a fonte de verdade):
  nome `Área/Local` no formato `^[A-Za-z]+(/[A-Za-z_+-]+)+$`, até 64 caracteres e conhecido
  pelo tzdata. Portanto **`Etc/UTC`, não `UTC`** (sem `/`), e nada com dígito: `Etc/GMT+3`
  (offset fixo, de sinal invertido) e nomes que o PostgreSQL leria como especificação POSIX
  (`Abc/Def3`) são recusados. O formato nunca é mais estrito que o do banco: o que o banco
  aceita passa aqui (paridade no `pnpm test:db`). O inverso depende do tzdata de cada lado:
  links legados que o ICU do Node conhece (`US/Eastern`, `Brazil/East`) passam no core, mas um
  PostgreSQL sem `tzdata-legacy` os recusa (verificado no PG 16.15 do Ubuntu 24.04). O próprio
  `Intl.supportedValuesOf('timeZone')` do Node 22 (ICU 77.1) lista 18 deles como canônicos
  (`Asia/Calcutta`, `America/Buenos_Aires`, `Europe/Kiev`...). Por isso o cadastro de unidade
  [planejado] deve oferecer uma lista fixa de nomes IANA atuais (as 16 zonas do Brasil),
  nunca a lista do runtime.
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
  aritmética inteira com busca binária nas ocupações. O custo cresce com **datas × inícios
  da grade por dia** (e com o número de trechos ocupados do serviço; o banco limita a 8
  fases), não só com as datas. Medições pontuais neste container (Node 22, 4 vCPU), **sem
  guarda de regressão** (o job noturno roda só as propriedades; um benchmark nele é
  [planejado]):
  - 60 dias, grade de 5 min, 400 ocupações → ~32 ms por chamada (2.424 horários);
  - pior caso no teto de trabalho (70 dias, grade de 5 min, jornada de 24 h todos os dias,
    serviço de 5 min, sem ocupações) → ~200 ms e 2,6 MB de JSON (20.160 horários);
  - para comparação, sem o teto: 366 dias na grade de 5 min com jornada de 24 h davam ~1 s e
    13 MB de JSON por chamada, e na grade de 1 min ~5 s.
- **Limites**: até 366 datas por consulta (`MAX_RANGE_DAYS`) **e** no máximo
  `MAX_CANDIDATE_STARTS` = 20.160 inícios candidatos (datas × ⌈1440 / granularidade⌉: 70 dias
  na grade de 5 min, 210 na de 15 min, 366 na de 30 min). Acima disso a consulta é recusada no
  campo `to`: divida-a em páginas. Granularidade de 1 a 1440 min, antecedência e horizonte até
  2 anos (`MAX_NOTICE_MINUTES`), serviço de até 24 h. Entrada inválida lança
  `SchedulingInputError` com o campo ofensor (`field`).
- **Página pública** [planejado], requisito para quem chamar: o servidor limita `from`/`to` a
  `[hoje no fuso da unidade, hoje + max_advance_days]` e a uma janela de no máximo 31 dias
  (zod estrito, nunca o intervalo do cliente direto), além do rate limit por IP e slug. O
  teto do core é a última linha, não a única.
- **Relógio que volta para a véspera**: até 2010, em America/St_Johns, Goose_Bay e Moncton a
  transição era às 00:01 e devolvia o relógio a 23:01 do dia anterior (Antarctica/Casey fez
  o mesmo em 2010-03-05). Esses instantes não viram horário de nenhum dos dois dias; 00:00 do
  dia acontece duas vezes, distinguido pelo `utcOffset`.

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
decide se é idempotente) ou `unknown_status`. `occupiesSchedule(status)` diz se as ocupações
(`occupancies`) continuam ativas (falso para cancelados, `no_show` e `expired`).

A tabela espelha o guard de status do banco: mantenha os dois em sincronia. Quem pode disparar
cada transição (cliente, equipe, sistema) é autorização e entra com a autenticação.

## Testes

```bash
pnpm --filter @salon/scheduling-core test          # exemplos + propriedades, com cobertura
FC_NUM_RUNS=2000 pnpm --filter @salon/scheduling-core test   # mais casos (~3 min; o job noturno)
# reproduz a falha de UMA propriedade (seed e path do fast-check, nome do teste do Vitest)
FC_SEED=<seed> FC_PATH=<path> pnpm --filter @salon/scheduling-core exec vitest run <arquivo> -t '<nome do teste>'
pnpm --filter @salon/scheduling-core test --sequence.seed=<semente>   # reproduz a ordem
TZ=Pacific/Kiritimati pnpm --filter @salon/scheduling-core test   # prova independência do fuso da máquina
```

- Job noturno: `.github/workflows/nightly.yml` roda todo dia às 05:43 UTC (e sob demanda)
  com `CI=1` e `FC_NUM_RUNS=2000`, em `TZ` UTC, America/Sao_Paulo e Pacific/Kiritimati
  (~3 min por fuso; 179 s em Kiritimati, medido localmente). Não é check obrigatório. Em
  falha, o resumo do run traz a semente do Vitest, as linhas FAIL e o seed/path do fast-check.
- Reproduzir uma propriedade: `FC_SEED`/`FC_PATH` valem para TODAS as propriedades da
  execução (as outras falham com "Unable to replay"), por isso filtre o arquivo e o teste. Não
  use o script `test` com filtro de arquivo: ele liga a cobertura por arquivo e os arquivos
  não carregados reprovam com 0%. O `@fast-check/vitest` acrescenta `(with seed=N)` ao nome
  do teste; `-t` casa por trecho do nome.
- Ordem aleatória: `sequence.shuffle: true` embaralha arquivos e testes a cada execução, o
  que expõe dependência de ordem ou de estado deixado por outro teste. O Vitest imprime a
  semente (`Running tests with seed "..."`) e `test/test-hygiene.test.ts` fixa a opção.

- `*.test.ts`: exemplos que documentam o comportamento (inclusive cada caso de horário de
  verão). `*.prop.test.ts`: propriedades com fast-check (tag `property`).
- Cobertura mínima por arquivo: linhas 95%, ramos 90%, funções 95%, instruções 95%. Não se
  contorna: `allowOnly: false` na config (`.only` quebra também fora do CI), a regra
  `no-warning-comments` do ESLint (bloco `salon/cobertura-honesta` da base, em todo arquivo)
  recusa dicas de exclusão de cobertura, e `test/test-hygiene.test.ts` varre `src/` e `test/`
  atrás dessas dicas e de testes focados, pulados, pendentes ou "esperados falhando" escritos
  por modificador, colchetes, pulo pelo contexto ou chave no objeto de opções (inclusive sob
  `eslint-disable` ou `biome-ignore`), além de fixar os pisos, o `include`, os reporters, as
  tags e o script `test`.
- Teste desligado reprova pelo RESULTADO, não só pelo texto: o reporter compartilhado
  `test-support/vitest-no-disabled-tests-reporter.ts` da raiz (em `vitest.config.ts`, ao lado
  dos reporters padrão; o mesmo do `@salon/db` e do `@salon/web`, e
  `test/support/no-disabled-tests-reporter.ts` só o reexporta) faz a execução sair com 1 e lista cada teste que terminou pulado, pendente ou com
  falha esperada, qualquer que seja a sintaxe (opção em variável ou espalhada, tag,
  supressão do Biome). Em execução filtrada (`-t`, `arquivo:linha`, `--tags-filter`) só os
  testes selecionados contam, porque o Vitest marca como pulado o que o filtro deixou de
  fora; o portão completo é a execução sem filtro (`pnpm test` e CI).
  `test/no-disabled-tests-reporter.test.ts` prova isso subindo o Vitest em processo filho
  sobre sondas.
- O oráculo de força bruta (`test/oracles/`) usa só Temporal e nanossegundos em `bigint`,
  independente da aritmética do motor. Os arbitrários (`test/arbitraries/`) puxam datas das
  transições reais do tzdata em 14 fusos (Brasil, Nova York, Santiago, Lisboa, Londres, Lord
  Howe, Chatham, Kathmandu, Kiritimati, Apia, Etc/UTC) e, à parte, dos dias de 1987 a 2010 em que o
  relógio voltou para a véspera (St. John's, Goose Bay, Moncton, Casey), onde P1, P8 e P9
  rodam de novo. A máquina de estados é testada contra uma tabela escrita à mão
  (`test/support/appointment-transitions.ts`), não contra a tabela do próprio código.
- Propriedades de `computeAvailableSlots`: P1 dentro da jornada; P2 sem colisão com ocupação
  ou bloqueio (fases e buffers); P3 ordem, unicidade e duração; P4 antecedência e horizonte;
  P5 reservas sequenciais nunca se sobrepõem; P6 monotonicidade ao surgir ocupação; P7 oráculo
  minuto a minuto; P8 rótulo, offset e ida e volta pelo Temporal; P9 igualdade com o oráculo
  de força bruta (completude e correção); P10 grade local; P11 determinismo e entrada
  intacta; P12 pausa livre; P13 translação (fuso fixo ≡ UTC deslocado); P14 monotonicidade em
  antecedência e horizonte; P15 indiferença à ordem e à origem das ocupações. Ocupações da
  reserva: uma linha por buffer e por fase de trabalho (oráculo) e união igual a
  `staffBusyIntervals`.
- Fuso: os exemplos de `assertIanaTimeZone` repetem os casos aceitos e recusados do teste de
  integração do `@salon/db` (conferência automática só no `pnpm test:db`, que exige que todo
  nome aceito pelo banco passe no core), e uma propriedade prova que todo nome aceito
  pelo core tem o formato do CHECK do banco (nomes do runtime, `Etc/GMT±N`, maiúsculas e
  minúsculas, nomes reais com dígito, barra ou espaço inseridos e cadeias aleatórias).
- `test/lint-rules.test.ts` prova que as regras de pureza disparam (relógio, aleatoriedade,
  `Date`, formatação local, I/O), inclusive o `Date.parse` da base (chamada, referência e
  desestruturação): o pacote redeclara `no-restricted-properties` e por isso compõe
  `machineTimeZoneRestrictedProperties` do `eslint.base.mjs`. Esse bloco da base
  (`salon/fuso-da-maquina`) vale em todo o monorepo, testes inclusive: proíbe `new Date` com
  data-hora sem offset e qualquer `Date.parse`. No domínio puro, todo `new Date(...)` já é
  proibido.

## Fora do escopo (próximas iterações)

- "Qualquer profissional" (união por horário) e serviços em sequência com profissionais
  diferentes: o chamador combina chamadas por profissional por enquanto.
- Recursos físicos (cadeira, lavatório), feriados da unidade (`location_holidays`) e horas
  extras (`extra_hours`) somando à jornada.
- Turnos que atravessam a meia-noite.
- Regras de autorização por ator nas transições de status.
- Node 26 traz Temporal nativo: trocar o import de `temporal-polyfill` pelo global num só
  lugar quando o runtime de produção migrar.
