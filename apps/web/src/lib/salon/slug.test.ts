/* eslint-disable security/detect-non-literal-fs-filename -- lê a pasta fixa src/app do próprio pacote. */
import { readdirSync } from 'node:fs';
import { SLUG_PATTERN } from '@salon/db';
import { describe, expect, it } from 'vitest';
import { isUsableSalonSlug, RESERVED_SLUGS, SLUG_MAX_LENGTH, SLUG_REGEX, slugify } from './slug';

describe('slugify', () => {
  it.each([
    ['Salão Bela Vista', 'salao-bela-vista'],
    ['  Barbearia do Zé  ', 'barbearia-do-ze'],
    ['Espaço & Cia. — Unhas', 'espaco-cia-unhas'],
    ['ÁÉÍÓÚ àèìòù âêô ãõ ç ñ', 'aeiou-aeiou-aeo-ao-c-n'],
    ['Studio 21', 'studio-21'],
    ['---Corte---', 'corte'],
  ])('%s -> %s', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it('devolve vazio quando nada sobra (emoji, só pontuação)', () => {
    expect(slugify('✂️💈')).toBe('');
    expect(slugify('!!!')).toBe('');
  });

  it('corta no tamanho máximo sem deixar hífen no fim', () => {
    const slug = slugify(`${'a'.repeat(62)} b`);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
    expect(SLUG_REGEX.test(slug)).toBe(true);
  });

  it('o resultado não vazio sempre cumpre o padrão do banco', () => {
    for (const name of ['Á', 'a b c', 'Ünïcödé Çafé', 'x'.repeat(200), 'A-B--C']) {
      const slug = slugify(name);
      expect(SLUG_REGEX.test(slug), name).toBe(true);
    }
  });
});

describe('padrão do slug', () => {
  it('é o mesmo CHECK do banco (tenants_slug_format e locations_slug_format)', () => {
    expect(SLUG_REGEX.source).toBe(SLUG_PATTERN);
  });
});

describe('isUsableSalonSlug', () => {
  it('aceita slug comum', () => {
    expect(isUsableSalonSlug('salao-bela-vista')).toBe(true);
  });

  it.each(['ab', 'Salao', 'salão', '-salao', 'salao-', 'salao bela', 'a'.repeat(64)])(
    'recusa formato inválido: %s',
    (slug) => {
      expect(isUsableSalonSlug(slug)).toBe(false);
    },
  );

  it.each(['salao-11987654321', 'barbearia-12345678901', '12345678', 'unhas-12-345-678-0001-99'])(
    'recusa sequência de 8 ou mais dígitos (CPF, CNPJ, telefone na URL pública): %s',
    (slug) => {
      expect(isUsableSalonSlug(slug)).toBe(false);
    },
  );

  it('aceita números curtos (studio-21, salao-2024)', () => {
    expect(isUsableSalonSlug('studio-21')).toBe(true);
    expect(isUsableSalonSlug('salao-2024')).toBe(true);
  });

  it('recusa cada slug reservado', () => {
    for (const slug of RESERVED_SLUGS) {
      expect(isUsableSalonSlug(slug), slug).toBe(false);
    }
  });

  it('reserva o que imita a plataforma e as rotas conhecidas do Next', () => {
    for (const slug of ['admin', 'suporte', 'oficial', 'agenda-salao', 'api', 'app', 'robots']) {
      expect(RESERVED_SLUGS.has(slug), slug).toBe(true);
    }
  });

  it('todo segmento de topo de src/app (rota futura /[slug]) está reservado', () => {
    const appDir = new URL('../../app/', import.meta.url);
    const segments = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Grupos "(x)" e pastas privadas "_x" não viram segmento de URL.
      .filter((name) => !name.startsWith('(') && !name.startsWith('_'));
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(RESERVED_SLUGS.has(segment), segment).toBe(true);
    }
  });
});
