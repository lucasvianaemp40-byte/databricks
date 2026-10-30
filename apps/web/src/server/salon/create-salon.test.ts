import {
  OwnerNotEligibleError,
  type ProvisionTenantInput,
  SlugUnavailableError,
  TenantAlreadyProvisionedError,
} from '@salon/db';
import { describe, expect, it } from 'vitest';
import { createSalonFromForm, locationSlug } from './create-salon';

const OWNER = '0b6c9e3e-0d4e-4c55-9f53-0d6b8f2a1c11';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

const VALID = {
  salonName: 'Salão Bela Vista',
  salonSlug: 'salao-bela-vista',
  locationName: 'Unidade Centro',
  timezone: 'America/Manaus',
};

function run(
  fields: Record<string, string>,
  provision?: (i: ProvisionTenantInput) => Promise<unknown>,
) {
  const calls: ProvisionTenantInput[] = [];
  const logs: string[] = [];
  const outcome = createSalonFromForm({
    ownerUserId: OWNER,
    formData: form(fields),
    provision: (input) => {
      calls.push(input);
      return provision === undefined ? Promise.resolve() : provision(input);
    },
    logFailure: (line) => logs.push(line),
  });
  return { outcome, calls, logs };
}

describe('createSalonFromForm', () => {
  it('provisiona com o dono da SESSÃO e o slug da unidade derivado no servidor', async () => {
    const { outcome, calls } = run(VALID);
    expect(await outcome).toEqual({ kind: 'created' });
    expect(calls).toEqual([
      {
        ownerUserId: OWNER,
        tenant: { name: 'Salão Bela Vista', slug: 'salao-bela-vista' },
        location: { name: 'Unidade Centro', slug: 'unidade-centro', timezone: 'America/Manaus' },
      },
    ]);
  });

  it.each(['tenantId', 'ownerUserId', 'id', 'role', 'status'])(
    'chave extra %s: recusa sem provisionar (mass assignment)',
    async (key) => {
      const { outcome, calls } = run({ ...VALID, [key]: '019a0000-0000-7000-8000-000000000001' });
      expect((await outcome).kind).toBe('invalid');
      expect(calls).toEqual([]);
    },
  );

  it('campo inválido: erro no campo e os valores de volta', async () => {
    const { outcome, calls } = run({ ...VALID, salonSlug: 'admin', timezone: 'UTC' });
    const result = await outcome;
    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      kind: 'invalid',
      state: {
        fieldErrors: {
          salonSlug: expect.any(String) as unknown,
          timezone: expect.any(String) as unknown,
        },
        values: { salonName: 'Salão Bela Vista', salonSlug: 'admin' },
      },
    });
  });

  it('endereço em uso: mensagem no campo do endereço', async () => {
    const { outcome } = run(VALID, () =>
      Promise.reject(new SlugUnavailableError('tenants_slug_key', new Error('x'))),
    );
    expect(await outcome).toMatchObject({
      kind: 'invalid',
      state: { fieldErrors: { salonSlug: 'Este endereço já está em uso. Escolha outro.' } },
    });
  });

  it('conta que já tem salão ou não confirmada: resultados próprios', async () => {
    expect(
      await run(VALID, () => Promise.reject(new TenantAlreadyProvisionedError())).outcome,
    ).toEqual({
      kind: 'already-has-salon',
    });
    expect(await run(VALID, () => Promise.reject(new OwnerNotEligibleError())).outcome).toEqual({
      kind: 'not-eligible',
    });
  });

  it('falha inesperada: mensagem genérica e log só com nome e código (sem os parâmetros)', async () => {
    const leaked = Object.assign(
      new Error('Failed query: insert ... params: Salão Bela Vista,dona@example.test'),
      {
        name: 'DrizzleQueryError',
      },
    );
    const { outcome, logs } = run(VALID, () => Promise.reject(leaked));
    const result = await outcome;
    expect(result).toMatchObject({
      kind: 'invalid',
      state: { message: expect.stringMatching(/Tente de novo/) as unknown },
    });
    expect(logs).toEqual(['DrizzleQueryError']);
  });
});

describe('locationSlug', () => {
  it('deriva do nome e nunca fica vazio', () => {
    expect(locationSlug('Unidade Centro')).toBe('unidade-centro');
    expect(locationSlug('✂️💈')).toBe('unidade');
  });
});
