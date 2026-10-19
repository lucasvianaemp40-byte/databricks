import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { generateNonce, isValidNonce, NONCE_BYTES, type RandomBytesSource } from './nonce';

/** Oráculo independente: a codificação base64 do Node para os mesmos bytes. */
function nodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

const counting: RandomBytesSource = (bytes) => bytes.map((_, index) => index);
const VALID = generateNonce(counting);

describe('generateNonce', () => {
  it('codifica 16 bytes em base64 padrão (24 caracteres)', () => {
    expect(VALID).toBe(nodeBase64(counting(new Uint8Array(NONCE_BYTES))));
    expect(VALID).toHaveLength(24);
  });

  it('usa o alfabeto base64 padrão, inclusive + e / (não base64url)', () => {
    // 0xfb 0xff -> "+/": os dois caracteres que diferem do base64url.
    const plusSlash: RandomBytesSource = (bytes) => bytes.fill(0xff).fill(0xfb, 0, 1);
    const nonce = generateNonce(plusSlash);
    expect(nonce).toBe(nodeBase64(plusSlash(new Uint8Array(NONCE_BYTES))));
    expect(nonce).toMatch(/^\+\//);
    expect(isValidNonce(nonce)).toBe(true);
  });

  it('pede exatamente 128 bits à fonte aleatória', () => {
    let requested = 0;
    generateNonce((bytes) => {
      requested = bytes.length;
      return bytes;
    });
    expect(requested).toBe(NONCE_BYTES);
    expect(NONCE_BYTES * 8).toBe(128);
  });

  it('falha se a fonte devolver menos bytes que o pedido', () => {
    expect(() => generateNonce(() => new Uint8Array(8))).toThrow(RangeError);
  });

  it('usa o CSPRNG por padrão: formato válido e sem repetição', () => {
    const nonces = Array.from({ length: 1000 }, () => generateNonce());
    for (const nonce of nonces) {
      expect(isValidNonce(nonce)).toBe(true);
    }
    expect(new Set(nonces).size).toBe(nonces.length);
  });
});

describe('isValidNonce', () => {
  const body = VALID.slice(0, 22);

  it('aceita o formato gerado', () => {
    expect(isValidNonce(VALID)).toBe(true);
  });

  it.each([
    ['vazio', ''],
    ['sem um caractere de padding', VALID.slice(0, -1)],
    ['sem padding', `${body}AA`],
    ['longo demais', `${VALID}AAAA`],
    ['com aspas', `${body.slice(0, -1)}'==`],
    ['com ponto e vírgula', `${body.slice(0, -1)};==`],
    ['com quebra de linha', `${body.slice(0, -1)}\n==`],
    ['em base64url', `${body.slice(0, -2)}-_==`],
  ])('rejeita %s', (_case, value) => {
    expect(isValidNonce(value)).toBe(false);
  });
});
