import { describe, expect, it, vi } from 'vitest';
import { createDb } from './client';
import { parseTenantId, withTenant } from './tenant';

describe('parseTenantId', () => {
  it('normaliza para minúsculas', () => {
    expect(parseTenantId('550E8400-E29B-41D4-A716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it.each([
    '',
    "x'; select set_config('app.tenant_id', 'outro', false); --",
    '00000000-0000-0000-0000-000000000000',
    null,
  ])('recusa %j', (value) => {
    expect(() => parseTenantId(value)).toThrow(TypeError);
  });
});

describe('withTenant (validação antes de tocar no banco)', () => {
  // Pool apontando para lugar nenhum: se a validação falhar em barrar, a conexão seria tentada.
  const db = createDb('postgresql://127.0.0.1:1/inexistente', {
    connectionTimeoutMillis: 50,
    onPoolError: () => undefined,
  });

  it('recusa tenantId inválido sem abrir conexão', async () => {
    const connect = vi.spyOn(db.$client, 'connect');
    await expect(withTenant(db, 'tenant-a', () => Promise.resolve('nunca'))).rejects.toThrow(
      'tenantId precisa ser um UUID válido',
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'admin' as 'staff' }, 'actor.type inválido'],
    [{ type: 'staff' as const, id: '' }, 'actor.id'],
    [{ type: 'staff' as const, id: 'tem espaço' }, 'actor.id'],
    [{ type: 'staff' as const, id: 'x'.repeat(129) }, 'actor.id'],
  ])('recusa ator inválido %j', async (actor, message) => {
    await expect(
      withTenant(db, '550e8400-e29b-41d4-a716-446655440000', () => Promise.resolve(1), { actor }),
    ).rejects.toThrow(message);
  });

  it('recusa uma transação no lugar do banco (não troca de tenant no meio da transação)', async () => {
    const { $client: _client, ...notADatabase } = db;
    await expect(
      withTenant(notADatabase as unknown as typeof db, '550e8400-e29b-41d4-a716-446655440000', () =>
        Promise.resolve(1),
      ),
    ).rejects.toThrow('não uma transação');
  });
});

describe('createDb', () => {
  it('recusa URL que não é PostgreSQL', () => {
    expect(() => createDb('mysql://localhost/db')).toThrow(TypeError);
  });
});
