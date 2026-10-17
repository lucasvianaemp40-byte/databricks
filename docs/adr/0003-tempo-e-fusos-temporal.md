# ADR-0003: Tempo e fusos com Temporal e fuso IANA por unidade

- **Status:** Aceito
- **Data:** 2026-10-17
- **Relacionados:** [packages/scheduling-core/README.md](../../packages/scheduling-core/README.md),
  [domínio](../dominio/modelo.md), [arquitetura, seção 6](../arquitetura.md#6-tempo-e-fuso-horário)

## Contexto

Agenda é tempo. Os erros clássicos são deslocar todos os horários futuros quando a regra de
fuso muda, oferecer horário inexistente, depender do fuso do servidor e testes que passam
num fuso e falham em outro.

Fatos verificados no tzdata ([eggert/tz](https://github.com/eggert/tz)) e em execução local:

- O Brasil tem **16 zonas IANA**, de −02 (`America/Noronha`) a −05 (`America/Rio_Branco`).
  Uma rede de salões pode ter unidades em fusos diferentes, como Manaus (−04) e São Paulo
  (−03).
- O horário de verão foi extinto pelo **Decreto 9.772/2019**, e o tzdata não tem regra
  brasileira depois de 2019. A volta é decisão anual do governo: segundo fonte secundária, o
  MME manteve a suspensão para 2026/27. O tzdata mudou várias vezes em 2026 (versão 2026e, de
  29/09/2026).
- O Node 26 traz Temporal habilitado por padrão. No Node 22 e 24, `temporal-polyfill` 1.0.6.
- O `timestamp AT TIME ZONE` do PostgreSQL resolve hora ambígua para a **segunda** ocorrência
  e empurra hora inexistente **para frente**. A desambiguação `'compatible'` do Temporal pode
  inverter um intervalo dentro de uma lacuna de horário de verão. Os dois casos foram
  verificados no PostgreSQL 16.15 e no motor.

## Decisão

1. **Instantes em UTC:** `timestamptz` no banco, `Temporal.Instant` no domínio, sessões do
   banco com `TimeZone=UTC` (via `withTenant`).
2. **Fuso IANA por unidade** (`locations.timezone`, default `America/Sao_Paulo`), validado
   contra o tzdata no banco (`app_private.is_valid_iana_timezone`) e no core
   (`assertIanaTimeZone`). Offset fixo (`-03:00`) e nomes fora de `Área/Local` (`UTC-3`,
   `Brasil/Brasilia`) são recusados.
3. **Regras "de parede" em hora local:** jornada em `time` + dia ISO + vigência, convertida
   para instantes **dia a dia**.
4. **O agendamento guarda instante, hora de parede e fuso** (`starts_at`, `local_starts_at`,
   `timezone`). Se a regra de fuso mudar, um job recalcula os futuros a partir da hora de
   parede **usando o core** (nunca `AT TIME ZONE`, ver item 6). Colisões passam pelo `EXCLUDE`
   e vão para a recepção.
5. **Domínio com Temporal** importado do módulo (`import { Temporal } from
   'temporal-polyfill'`), nunca como global. Quando o runtime de produção for o Node 26, a
   troca pelo global nativo acontece num só lugar.
6. **Hora de parede → instante** com regra própria e monotônica: o primeiro instante do dia
   local em que o relógio marca um horário maior ou igual ao pedido. Hora ambígua resolve para
   a primeira ocorrência, hora inexistente para o instante da transição e `24:00` para o
   início do dia seguinte. Um turno com início < fim nunca vira intervalo invertido. O SQL não
   reconverte hora de parede: grava o instante calculado pelo core.
7. **Grade local:** os inícios caem em `00:00 + k × granularidade` no relógio da unidade.
   Rótulo local repetido gera dois horários, distinguidos por `utcOffset`, e a UI mostra o
   offset nesse caso.
8. **Relógio injetado:** `Clock` com `systemClock` (único ponto que lê o relógio real) e
   `fixedClock` para testes. O lint proíbe no core `Date.now`, `new Date()` sem argumento,
   `Date()`, `Temporal.Now`, `performance.now`, `Math.random`, `crypto.randomUUID`, getters
   locais de `Date` e `resolvedOptions`.
9. **Testes de propriedade** com fusos que têm horário de verão (Nova York, Santiago, Lisboa,
   Lord Howe, Chatham, Kathmandu, Kiritimati, Apia e outros) e datas das transições reais do
   tzdata. O CI roda os testes em `TZ=UTC` e `TZ=America/Sao_Paulo`.

## Consequências

- **Positivas:**
  - a volta do horário de verão não quebra a agenda;
  - resultados reproduzíveis;
  - multi-fuso desde o MVP sem custo extra;
  - 15 propriedades do motor verificadas com oráculo de força bruta independente.
- **Negativas e riscos:**
  - turno que atravessa a meia-noite (barbearia até 01:00) fica fora do escopo e é recusado
    pelo CHECK;
  - o tzdata precisa estar atualizado no Node (ICU) e no PostgreSQL;
  - o polyfill aumenta o bundle do cliente. O suporte nativo a Temporal nos navegadores-alvo
    não foi verificado;
  - duas regras de desambiguação convivem, a do core e a do PostgreSQL, e isso precisa estar
    documentado.
- **Ações decorrentes:**
  - job de recálculo de agendamentos futuros quando o tzdata mudar [planejado];
  - componente de UI que mostra o offset em rótulo repetido;
  - migrar para o Temporal nativo com o Node 26.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Só UTC no banco, sem hora de parede | Uma mudança de regra de fuso desloca todos os agendamentos futuros em 1 h |
| `Date` + offset fixo `-03:00` | Quebra em Manaus, Noronha e Acre e na volta do horário de verão |
| `date-fns` 4 + `@date-fns/tz` | Bom para a UI, mas o comportamento em hora inexistente e ambígua não estava documentado (não verificado). Fica reservado para componentes de UI que o exijam |
| Luxon | API de objeto mutável-ish e outra regra de desambiguação. O Temporal é o padrão da plataforma |
| Converter hora de parede no SQL (`AT TIME ZONE`) | Regra de desambiguação diferente da do core (verificado) |

## Referências

- Temporal (TC39): https://tc39.es/proposal-temporal/docs/
- tzdata: https://github.com/eggert/tz (arquivos `southamerica`, `zone1970.tab`, `NEWS`)
- Decreto 9.772/2019: https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2019/decreto/D9772.htm
- Changelog do Node 26: https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V26.md
