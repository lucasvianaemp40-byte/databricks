import { assertIanaTimeZone } from '@salon/scheduling-core';
import { describe, expect, it } from 'vitest';
import {
  BRAZIL_TIME_ZONES,
  DEFAULT_TIME_ZONE,
  isBrazilTimeZone,
  timeZoneOptions,
  utcOffsetLabel,
} from './brazil-timezones';

describe('fusos do Brasil (lista fixa, nunca Intl.supportedValuesOf)', () => {
  it('tem as 16 zonas IANA atuais do Brasil, sem repetição', () => {
    const ids = BRAZIL_TIME_ZONES.map((zone) => zone.id);
    expect(new Set(ids).size).toBe(16);
    expect([...ids].sort()).toEqual([
      'America/Araguaina',
      'America/Bahia',
      'America/Belem',
      'America/Boa_Vista',
      'America/Campo_Grande',
      'America/Cuiaba',
      'America/Eirunepe',
      'America/Fortaleza',
      'America/Maceio',
      'America/Manaus',
      'America/Noronha',
      'America/Porto_Velho',
      'America/Recife',
      'America/Rio_Branco',
      'America/Santarem',
      'America/Sao_Paulo',
    ]);
  });

  it('cada zona é aceita pelo domínio (mesma regra do CHECK do banco)', () => {
    for (const { id } of BRAZIL_TIME_ZONES) {
      expect(() => assertIanaTimeZone(id), id).not.toThrow();
    }
  });

  it('o padrão é America/Sao_Paulo', () => {
    expect(DEFAULT_TIME_ZONE).toBe('America/Sao_Paulo');
    expect(isBrazilTimeZone(DEFAULT_TIME_ZONE)).toBe(true);
  });

  it.each(['UTC', 'Etc/UTC', 'Etc/GMT+3', '-03:00', 'America/Buenos_Aires', 'america/sao_paulo'])(
    'recusa %s',
    (value) => {
      expect(isBrazilTimeZone(value)).toBe(false);
    },
  );
});

describe('rótulo do offset', () => {
  it('calcula o offset do instante pelo tzdata (sem offset digitado à mão)', () => {
    const instant = new Date('2026-10-20T12:00:00Z');
    expect(utcOffsetLabel('America/Sao_Paulo', instant)).toBe('UTC−03:00');
    expect(utcOffsetLabel('America/Noronha', instant)).toBe('UTC−02:00');
    expect(utcOffsetLabel('America/Manaus', instant)).toBe('UTC−04:00');
    expect(utcOffsetLabel('America/Rio_Branco', instant)).toBe('UTC−05:00');
  });

  it('acompanha o horário de verão quando ele existe (São Paulo em jan/2019)', () => {
    expect(utcOffsetLabel('America/Sao_Paulo', new Date('2019-01-15T12:00:00Z'))).toBe('UTC−02:00');
  });

  it('as opções do seletor trazem região e offset, com Brasília primeiro', () => {
    const options = timeZoneOptions(new Date('2026-10-20T12:00:00Z'));
    expect(options).toHaveLength(16);
    expect(options[0]).toEqual({
      value: 'America/Sao_Paulo',
      label: expect.stringMatching(/^Horário de Brasília .*\(UTC−03:00\)$/) as unknown,
    });
    for (const option of options) {
      expect(option.label, option.value).toMatch(/\(UTC[−+]\d{2}:\d{2}\)$/);
    }
  });
});
