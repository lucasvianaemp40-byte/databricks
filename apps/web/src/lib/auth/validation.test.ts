import { describe, expect, it } from 'vitest';
import {
  createSalonSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  signInSchema,
  signUpSchema,
  suggestSlug,
} from './validation';

const VALID_PASSWORD = 'cabelo-curto-2026';

describe('validação do cadastro do dono', () => {
  it('aceita nome, e-mail e senha de 12 a 128 caracteres; normaliza o e-mail', () => {
    const parsed = signUpSchema.parse({
      name: '  Dona Maria ',
      email: ' Maria@Exemplo.COM ',
      password: VALID_PASSWORD,
    });
    expect(parsed).toEqual({
      name: 'Dona Maria',
      email: 'maria@exemplo.com',
      password: VALID_PASSWORD,
    });
  });

  it.each([
    ['senha curta', { password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1) }, 'password'],
    ['senha longa', { password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1) }, 'password'],
    ['e-mail inválido', { email: 'maria' }, 'email'],
    ['e-mail longo demais', { email: `${'a'.repeat(250)}@x.com` }, 'email'],
    ['nome vazio', { name: '   ' }, 'name'],
    ['nome longo demais', { name: 'a'.repeat(121) }, 'name'],
  ])('recusa %s', (_label, override, field) => {
    const result = signUpSchema.safeParse({
      name: 'Dona Maria',
      email: 'maria@exemplo.com',
      password: VALID_PASSWORD,
      ...override,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
  });

  it('a senha não é aparada (espaços contam) e aceita exatamente 12 e 128 caracteres', () => {
    for (const password of [' '.repeat(12), 'a'.repeat(128), `  ${VALID_PASSWORD}  `]) {
      expect(signUpSchema.parse({ name: 'Ana', email: 'ana@exemplo.com', password }).password).toBe(
        password,
      );
    }
  });

  it('é estrito: campo extra é recusado (nada de id, role ou tenant vindos do cliente)', () => {
    const result = signUpSchema.safeParse({
      name: 'Ana',
      email: 'ana@exemplo.com',
      password: VALID_PASSWORD,
      role: 'owner',
    });
    expect(result.success).toBe(false);
  });
});

describe('validação do login', () => {
  it('aceita e-mail e qualquer senha não vazia até 128 (a política vale no cadastro)', () => {
    expect(signInSchema.parse({ email: 'Ana@Exemplo.com', password: 'x' })).toEqual({
      email: 'ana@exemplo.com',
      password: 'x',
    });
    expect(signInSchema.safeParse({ email: 'ana@exemplo.com', password: '' }).success).toBe(false);
    expect(
      signInSchema.safeParse({ email: 'ana@exemplo.com', password: 'a'.repeat(129) }).success,
    ).toBe(false);
  });
});

describe('criação do salão (createSalonSchema)', () => {
  const valid = {
    salonName: 'Barbearia do Zé',
    slug: 'barbearia-do-ze',
    locationName: 'Centro',
    timezone: 'America/Sao_Paulo',
  };

  it('aceita os dados mínimos e apara os nomes', () => {
    expect(createSalonSchema.parse({ ...valid, salonName: '  Barbearia do Zé ' })).toEqual(valid);
  });

  it.each([
    ['slug com maiúscula', { slug: 'Barbearia' }, 'slug'],
    ['slug com acento', { slug: 'barbearia-do-zé' }, 'slug'],
    ['slug começando com hífen', { slug: '-barbearia' }, 'slug'],
    ['slug curto demais', { slug: 'ab' }, 'slug'],
    ['slug longo demais', { slug: 'a'.repeat(64) }, 'slug'],
    // Telefone ou CPF no endereço público: dado pessoal na URL (LGPD).
    ['slug com telefone', { slug: 'salao-11987654321' }, 'slug'],
    ['slug com CPF', { slug: 'salao-12345678909' }, 'slug'],
    ['slug reservado do sistema', { slug: 'painel' }, 'slug'],
    ['slug reservado da API', { slug: 'api' }, 'slug'],
    ['slug de arquivo do Next', { slug: 'robots' }, 'slug'],
    ['slug de ícone', { slug: 'favicon' }, 'slug'],
    ['fuso fora do Brasil', { timezone: 'Europe/Lisbon' }, 'timezone'],
    ['fuso por offset fixo', { timezone: 'Etc/GMT+3' }, 'timezone'],
    ['nome do salão vazio', { salonName: ' ' }, 'salonName'],
    ['nome da unidade longo demais', { locationName: 'a'.repeat(121) }, 'locationName'],
  ])('recusa %s', (_label, override, field) => {
    const result = createSalonSchema.safeParse({ ...valid, ...override });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
  });

  it('é estrito: tenantId ou id vindos do cliente são recusados', () => {
    expect(createSalonSchema.safeParse({ ...valid, tenantId: crypto.randomUUID() }).success).toBe(
      false,
    );
  });
});

describe('suggestSlug', () => {
  it.each([
    ['Barbearia do Zé', 'barbearia-do-ze'],
    ['  Salão  Beleza & Cia!! ', 'salao-beleza-cia'],
    ['Studio Ágata Ünïcode', 'studio-agata-unicode'],
    ['---', ''],
  ])('%j vira %j', (name, slug) => {
    expect(suggestSlug(name)).toBe(slug);
  });

  it('corta em 63 caracteres sem terminar em hífen', () => {
    const slug = suggestSlug(`${'a'.repeat(62)} b`);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith('-')).toBe(false);
  });
});
