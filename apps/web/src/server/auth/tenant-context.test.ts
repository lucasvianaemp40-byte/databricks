import { describe, expect, it } from 'vitest';
import { resolveAccess, type SessionLike } from './tenant-context';

const USER = { id: '0b6c9e3e-0d4e-4c55-9f53-0d6b8f2a1c11', name: 'Ana', email: 'ana@example.test' };
const verified: SessionLike = { user: { ...USER, emailVerified: true } };
const TENANT = '019a0000-0000-7000-8000-000000000001';

describe('resolveAccess (sessão -> vínculo -> tenant)', () => {
  it('sem sessão: anônimo, sem consultar vínculos', async () => {
    const access = await resolveAccess({
      getSession: () => Promise.resolve(null),
      listMemberships: () => Promise.reject(new Error('não deveria consultar')),
    });
    expect(access).toEqual({ kind: 'anonymous' });
  });

  it('sessão de e-mail não confirmado: anônimo', async () => {
    const access = await resolveAccess({
      getSession: () => Promise.resolve({ user: { ...USER, emailVerified: false } }),
      listMemberships: () => Promise.reject(new Error('não deveria consultar')),
    });
    expect(access).toEqual({ kind: 'anonymous' });
  });

  it('sem vínculo: precisa criar o salão (nunca um tenant padrão)', async () => {
    const access = await resolveAccess({
      getSession: () => Promise.resolve(verified),
      listMemberships: () => Promise.resolve([]),
    });
    expect(access).toEqual({ kind: 'no-tenant', user: USER });
  });

  it('o tenant vem do vínculo da pessoa da sessão', async () => {
    const asked: string[] = [];
    const access = await resolveAccess({
      getSession: () => Promise.resolve(verified),
      listMemberships: (userId) => {
        asked.push(userId);
        return Promise.resolve([{ tenantId: TENANT, role: 'owner' }]);
      },
    });
    expect(asked).toEqual([USER.id]);
    expect(access).toEqual({ kind: 'tenant', user: USER, tenantId: TENANT, role: 'owner' });
  });

  it('falha ao ler a sessão ou os vínculos propaga (nega, nunca libera)', async () => {
    await expect(
      resolveAccess({
        getSession: () => Promise.reject(new Error('banco fora')),
        listMemberships: () => Promise.resolve([]),
      }),
    ).rejects.toThrow('banco fora');
    await expect(
      resolveAccess({
        getSession: () => Promise.resolve(verified),
        listMemberships: () => Promise.reject(new Error('banco fora')),
      }),
    ).rejects.toThrow('banco fora');
  });
});
