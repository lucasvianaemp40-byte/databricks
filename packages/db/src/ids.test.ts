import { describe, expect, it } from 'vitest';
import { isUuid, newId } from './ids';

describe('newId', () => {
  it('deve gerar UUIDv7 canônico (versão 7, variante RFC 9562)', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('deve gerar ids únicos e em ordem não decrescente (prefixo de tempo)', () => {
    const ids = Array.from({ length: 500 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('isUuid', () => {
  it.each([
    '0192f8a1-7b2c-7d3e-8f40-123456789abc',
    '550e8400-e29b-41d4-a716-446655440000',
    '550E8400-E29B-41D4-A716-446655440000',
  ])('aceita %s', (value) => {
    expect(isUuid(value)).toBe(true);
  });

  it.each([
    '',
    'not-a-uuid',
    '550e8400-e29b-41d4-a716-446655440000'.replaceAll('-', ''),
    '{550e8400-e29b-41d4-a716-446655440000}',
    ' 550e8400-e29b-41d4-a716-446655440000',
    "550e8400-e29b-41d4-a716-446655440000'; --",
    '00000000-0000-0000-0000-000000000000',
    'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
    42,
    null,
    undefined,
  ])('recusa %j', (value) => {
    expect(isUuid(value)).toBe(false);
  });
});
