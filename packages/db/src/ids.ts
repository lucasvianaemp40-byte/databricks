import { v7 as uuidv7 } from 'uuid';

/**
 * Forma canônica de UUID (RFC 9562): 8-4-4-4-12 dígitos hexadecimais.
 * Aceita qualquer versão: tenants e linhas antigas podem ter sido criados com v4.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/**
 * Gera o identificador de uma linha nova: UUIDv7 (prefixo de tempo em ms), o que mantém
 * os índices B-tree das PKs com inserção quase sequencial.
 *
 * Gerado na aplicação porque o PostgreSQL 16/17 não tem `uuidv7()` (só o 18). IDs v7 são
 * parcialmente previsíveis (carregam o instante de criação): nunca use como segredo.
 */
export function newId(): string {
  return uuidv7();
}

/** `true` para um UUID canônico que não seja o nil nem o max (valores sentinela). */
export function isUuid(value: unknown): value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    return false;
  }
  const normalized = value.toLowerCase();
  return normalized !== NIL_UUID && normalized !== MAX_UUID;
}
