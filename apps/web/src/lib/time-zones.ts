/**
 * Fusos IANA do Brasil oferecidos no cadastro da unidade, com o nome que o dono reconhece.
 * São os 16 nomes canônicos do tzdata para o Brasil (sem links legados como Brazil/East).
 * O fuso fica na UNIDADE e é a referência de toda regra de parede (jornada, feriado).
 */
export interface BrazilTimeZone {
  readonly id: string;
  readonly label: string;
}

export const BRAZIL_TIME_ZONES: readonly BrazilTimeZone[] = [
  { id: 'America/Sao_Paulo', label: 'Horário de Brasília (SP, RJ, MG, ES, Sul, GO e DF)' },
  { id: 'America/Bahia', label: 'Bahia (Salvador)' },
  { id: 'America/Fortaleza', label: 'Ceará, Maranhão, Piauí, RN e Paraíba (Fortaleza)' },
  { id: 'America/Recife', label: 'Pernambuco (Recife)' },
  { id: 'America/Maceio', label: 'Alagoas e Sergipe (Maceió)' },
  { id: 'America/Belem', label: 'Pará leste e Amapá (Belém)' },
  { id: 'America/Santarem', label: 'Pará oeste (Santarém)' },
  { id: 'America/Araguaina', label: 'Tocantins (Araguaína)' },
  { id: 'America/Noronha', label: 'Fernando de Noronha' },
  { id: 'America/Campo_Grande', label: 'Mato Grosso do Sul (Campo Grande)' },
  { id: 'America/Cuiaba', label: 'Mato Grosso (Cuiabá)' },
  { id: 'America/Porto_Velho', label: 'Rondônia (Porto Velho)' },
  { id: 'America/Boa_Vista', label: 'Roraima (Boa Vista)' },
  { id: 'America/Manaus', label: 'Amazonas (Manaus)' },
  { id: 'America/Eirunepe', label: 'Amazonas oeste (Eirunepé)' },
  { id: 'America/Rio_Branco', label: 'Acre (Rio Branco)' },
];

const LABELS: ReadonlyMap<string, string> = new Map(
  BRAZIL_TIME_ZONES.map((zone) => [zone.id, zone.label]),
);

export function isBrazilTimeZone(value: string): boolean {
  return LABELS.has(value);
}

/** Nome amigável do fuso; o próprio id quando não é um fuso do Brasil. */
export function timeZoneLabel(id: string): string {
  return LABELS.get(id) ?? id;
}
