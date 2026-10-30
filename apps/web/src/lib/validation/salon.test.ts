import { describe, expect, it } from 'vitest';
import { createSalonSchema } from './salon';

const VALID = {
  salonName: 'Salão Bela Vista',
  salonSlug: 'salao-bela-vista',
  locationName: 'Unidade Centro',
  timezone: 'America/Manaus',
};

describe('createSalonSchema', () => {
  it('aceita o formulário válido', () => {
    expect(createSalonSchema.parse(VALID)).toEqual(VALID);
  });

  it('apara os nomes', () => {
    expect(createSalonSchema.parse({ ...VALID, salonName: '  Salão  ' }).salonName).toBe('Salão');
  });

  it.each(['tenantId', 'id', 'organizationId', 'role', 'status', 'ownerUserId'])(
    'recusa a chave extra %s (o servidor decide)',
    (key) => {
      expect(createSalonSchema.safeParse({ ...VALID, [key]: 'x' }).success).toBe(false);
    },
  );

  it.each(['UTC', 'Etc/GMT+3', 'America/Buenos_Aires', 'Europe/Lisbon'])(
    'recusa fuso fora da lista do Brasil: %s',
    (timezone) => {
      expect(createSalonSchema.safeParse({ ...VALID, timezone }).success).toBe(false);
    },
  );

  it.each(['api', 'app', 'admin', 'ab', 'Salao', 'salão', '-x-y'])(
    'recusa endereço reservado ou mal formado: %s',
    (salonSlug) => {
      expect(createSalonSchema.safeParse({ ...VALID, salonSlug }).success).toBe(false);
    },
  );

  it('recusa nome com caractere de controle ou bidi', () => {
    // biome-ignore lint/security/noSecrets: texto de teste com caractere bidi escapado, não é segredo.
    expect(createSalonSchema.safeParse({ ...VALID, salonName: 'Salão\u202E' }).success).toBe(false);
    expect(createSalonSchema.safeParse({ ...VALID, locationName: 'Centro\n' }).success).toBe(false);
  });

  it('recusa valor que não é texto', () => {
    expect(createSalonSchema.safeParse({ ...VALID, salonName: 42 }).success).toBe(false);
  });
});
