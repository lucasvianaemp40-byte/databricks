import { assertIanaTimeZone } from '@salon/scheduling-core';
import { describe, expect, it } from 'vitest';
import { BRAZIL_TIME_ZONES, isBrazilTimeZone, timeZoneLabel } from './time-zones';

describe('fusos do Brasil oferecidos no cadastro da unidade', () => {
  it('são os 16 fusos canônicos do tzdata para o Brasil, sem repetição', () => {
    const ids = BRAZIL_TIME_ZONES.map((zone) => zone.id);
    expect(new Set(ids).size).toBe(16);
    expect(ids).toContain('America/Sao_Paulo');
    expect(ids).toContain('America/Noronha');
    expect(ids).toContain('America/Rio_Branco');
  });

  it('todo fuso da lista é aceito pelo domínio (nome IANA "Área/Local" válido)', () => {
    for (const zone of BRAZIL_TIME_ZONES) {
      expect(() => assertIanaTimeZone(zone.id), zone.id).not.toThrow();
    }
  });

  it('o horário de Brasília vem primeiro (é o padrão do formulário)', () => {
    expect(BRAZIL_TIME_ZONES[0]?.id).toBe('America/Sao_Paulo');
  });

  it('isBrazilTimeZone recusa fuso fora da lista, offset fixo e lixo', () => {
    expect(isBrazilTimeZone('America/Manaus')).toBe(true);
    for (const value of ['Europe/Lisbon', 'UTC', 'Etc/GMT+3', '-03:00', '', 'America/sao_paulo']) {
      expect(isBrazilTimeZone(value), value).toBe(false);
    }
  });

  it('timeZoneLabel dá o nome amigável e cai no id para fuso desconhecido', () => {
    expect(timeZoneLabel('America/Sao_Paulo')).toMatch(/Brasília/);
    expect(timeZoneLabel('Europe/Lisbon')).toBe('Europe/Lisbon');
  });
});
