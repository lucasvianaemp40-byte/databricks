/**
 * Nonce de CSP: 128 bits de um CSPRNG por requisição, codificados em base64 (24 caracteres).
 *
 * O nonce só protege se for imprevisível e único por resposta (CSP3 §8.2). Por isso usamos
 * `crypto.getRandomValues` (Web Crypto, disponível no runtime Node.js do Proxy) e nunca
 * derivamos o valor de dados da requisição. O exemplo da documentação do Next usa
 * `btoa(crypto.randomUUID())`, que tem só 122 bits aleatórios e gasta 48 caracteres.
 */

/** Bytes de entropia do nonce (16 bytes = 128 bits, mínimo da CSP3 e do ASVS 5.0 3.4.3). */
export const NONCE_BYTES = 16;

/** Formato aceito para um nonce gerado aqui: base64 padrão de 16 bytes. */
const NONCE_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

/** Cabeçalho de requisição pelo qual o Proxy repassa o nonce aos Server Components. */
export const NONCE_REQUEST_HEADER = 'x-nonce';

/** Fonte de bytes aleatórios; injetável para testes determinísticos. */
export type RandomBytesSource = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

const webCryptoRandomBytes: RandomBytesSource = (bytes) => crypto.getRandomValues(bytes);

/** Gera um nonce novo. Chame uma vez por requisição; nunca reutilize nem armazene. */
export function generateNonce(randomBytes: RandomBytesSource = webCryptoRandomBytes): string {
  const bytes = randomBytes(new Uint8Array(NONCE_BYTES));
  if (bytes.length !== NONCE_BYTES) {
    throw new RangeError(
      `A fonte aleatória devolveu ${bytes.length} bytes; eram esperados ${NONCE_BYTES}.`,
    );
  }
  return btoa(String.fromCharCode(...bytes));
}

/** Verdadeiro se o valor tem o formato de um nonce gerado por {@link generateNonce}. */
export function isValidNonce(value: string): boolean {
  return NONCE_PATTERN.test(value);
}
