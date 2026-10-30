/**
 * Fusos do Brasil para a unidade (E2.1): lista FIXA das 16 zonas IANA atuais, nunca
 * `Intl.supportedValuesOf('timeZone')` (o ICU do Node lista links legados, como
 * `America/Buenos_Aires`, que um PostgreSQL sem tzdata-legacy recusa). O offset do rótulo é
 * calculado pelo tzdata no instante pedido: nada de "UTC−3" digitado à mão (o horário de
 * verão pode voltar). Módulo puro: roda no servidor e no navegador.
 */

export interface BrazilTimeZone {
  readonly id: string;
  /** Onde o fuso vale, para a pessoa reconhecer o dela. */
  readonly region: string;
}

/** Em ordem de exibição: Brasília primeiro (a maioria das unidades). */
export const BRAZIL_TIME_ZONES = [
  { id: 'America/Sao_Paulo', region: 'Horário de Brasília (SP, RJ, MG, ES, PR, SC, RS, GO e DF)' },
  { id: 'America/Bahia', region: 'Bahia' },
  { id: 'America/Fortaleza', region: 'Ceará, Maranhão, Piauí, Rio Grande do Norte e Paraíba' },
  { id: 'America/Recife', region: 'Pernambuco' },
  { id: 'America/Maceio', region: 'Alagoas e Sergipe' },
  { id: 'America/Belem', region: 'Pará (leste) e Amapá' },
  { id: 'America/Santarem', region: 'Pará (oeste)' },
  { id: 'America/Araguaina', region: 'Tocantins' },
  { id: 'America/Noronha', region: 'Fernando de Noronha' },
  { id: 'America/Campo_Grande', region: 'Mato Grosso do Sul' },
  { id: 'America/Cuiaba', region: 'Mato Grosso' },
  { id: 'America/Porto_Velho', region: 'Rondônia' },
  { id: 'America/Boa_Vista', region: 'Roraima' },
  { id: 'America/Manaus', region: 'Amazonas (leste)' },
  { id: 'America/Eirunepe', region: 'Amazonas (oeste)' },
  { id: 'America/Rio_Branco', region: 'Acre' },
] as const satisfies readonly BrazilTimeZone[];

export type BrazilTimeZoneId = (typeof BRAZIL_TIME_ZONES)[number]['id'];

export const BRAZIL_TIME_ZONE_IDS = BRAZIL_TIME_ZONES.map((zone) => zone.id) as [
  BrazilTimeZoneId,
  ...BrazilTimeZoneId[],
];

export const DEFAULT_TIME_ZONE: BrazilTimeZoneId = 'America/Sao_Paulo';

const IDS: ReadonlySet<string> = new Set(BRAZIL_TIME_ZONE_IDS);

export function isBrazilTimeZone(value: string): value is BrazilTimeZoneId {
  return IDS.has(value);
}

/** "UTC−03:00" no instante dado, com o sinal de menos tipográfico. */
export function utcOffsetLabel(timeZone: string, instant: Date): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((item) => item.type === 'timeZoneName')?.value;
  // "GMT-03:00" (ou "GMT" no offset zero).
  const offset = part === undefined || part === 'GMT' ? '+00:00' : part.replace('GMT', '');
  return `UTC${offset.replace('-', '−')}`;
}

export interface TimeZoneOption {
  readonly value: BrazilTimeZoneId;
  readonly label: string;
}

/** Opções do seletor no instante dado (o servidor passa "agora" na renderização). */
export function timeZoneOptions(instant: Date): TimeZoneOption[] {
  return BRAZIL_TIME_ZONES.map(({ id, region }) => ({
    value: id,
    label: `${region} (${utcOffsetLabel(id, instant)})`,
  }));
}
