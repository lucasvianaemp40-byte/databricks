import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/client';
import { TenantSlugTakenError } from '../../src/errors';
import { newId } from '../../src/ids';
import {
  createTenantWithFirstLocation,
  getTenantSummary,
  type NewTenantInput,
  TenantOnboardingConflictError,
} from '../../src/onboarding';
import { locations, tenants } from '../../src/schema';
import { withTenant } from '../../src/tenant';
import { connectAsAppUser } from '../helpers/connections';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';

function newTenantInput(overrides: Partial<NewTenantInput> = {}): NewTenantInput {
  const suffix = randomBytes(4).toString('hex');
  return {
    tenantId: newId(),
    name: 'Barbearia do Centro',
    slug: `barbearia-${suffix}`,
    location: { name: 'Unidade Centro', slug: 'centro', timezone: 'America/Manaus' },
    ...overrides,
  };
}

/** Lê o salão e as unidades como o próprio tenant (RLS ativa). */
function readAs(db: Database, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => ({
    tenants: await tx
      .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, status: tenants.status })
      .from(tenants),
    locations: await tx
      .select({ id: locations.id, name: locations.name, timezone: locations.timezone })
      .from(locations),
  }));
}

describe('criação do salão com a primeira unidade', () => {
  let db: Database;
  let otherTenant: TenantFixture;

  beforeAll(async () => {
    db = connectAsAppUser();
    otherTenant = await createTenantFixture(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('cria o salão (em trial) e a unidade no fuso pedido, com o id da organização', async () => {
    const input = newTenantInput();
    const created = await createTenantWithFirstLocation(db, input, {
      actor: { type: 'staff', id: 'user-onboarding' },
    });
    expect(created.tenantId).toBe(input.tenantId);

    const seen = await readAs(db, input.tenantId);
    expect(seen.tenants).toEqual([
      { id: input.tenantId, slug: input.slug, name: input.name, status: 'trial' },
    ]);
    expect(seen.locations).toEqual([
      { id: created.locationId, name: 'Unidade Centro', timezone: 'America/Manaus' },
    ]);
  });

  it('é idempotente: repetir (retomada depois de falha) devolve os mesmos ids sem duplicar', async () => {
    const input = newTenantInput();
    const first = await createTenantWithFirstLocation(db, input);
    const again = await createTenantWithFirstLocation(db, input);
    expect(again).toEqual(first);
    const seen = await readAs(db, input.tenantId);
    expect(seen.tenants).toHaveLength(1);
    expect(seen.locations).toHaveLength(1);
  });

  it('slug já usado por outro salão: TenantSlugTakenError e nada fica gravado', async () => {
    const input = newTenantInput({ slug: otherTenant.slug });
    await expect(createTenantWithFirstLocation(db, input)).rejects.toBeInstanceOf(
      TenantSlugTakenError,
    );
    const seen = await readAs(db, input.tenantId);
    expect(seen).toEqual({ tenants: [], locations: [] });
  });

  it('outro salão não vê o salão novo nem a unidade dele, e o novo não vê o outro (RLS)', async () => {
    const input = newTenantInput();
    await createTenantWithFirstLocation(db, input);

    const seenByOther = await readAs(db, otherTenant.tenantId);
    expect(seenByOther.tenants.map((row) => row.id)).toEqual([otherTenant.tenantId]);
    expect(seenByOther.locations.map((row) => row.id)).toEqual([otherTenant.locationId]);

    const seenByNew = await readAs(db, input.tenantId);
    expect(seenByNew.tenants.map((row) => row.id)).toEqual([input.tenantId]);
    expect(seenByNew.locations.map((row) => row.id)).not.toContain(otherTenant.locationId);
  });

  it('reenvio com OUTRA unidade num salão que já tem unidade: recusado, nada novo (sem unidade extra)', async () => {
    const input = newTenantInput();
    await createTenantWithFirstLocation(db, input);
    const replay = {
      ...input,
      location: { name: 'Filial', slug: 'filial', timezone: 'America/Sao_Paulo' },
    };
    await expect(createTenantWithFirstLocation(db, replay)).rejects.toBeInstanceOf(
      TenantOnboardingConflictError,
    );
    const seen = await readAs(db, input.tenantId);
    expect(seen.locations.map((location) => location.name)).toEqual(['Unidade Centro']);
  });

  it('não reaproveita salão existente de outro dono: id já usado com outro slug é recusado', async () => {
    const input = newTenantInput({ tenantId: otherTenant.tenantId });
    await expect(createTenantWithFirstLocation(db, input)).rejects.toThrow(
      'salão já existe com outros dados',
    );
  });
});

describe('resumo do salão (painel)', () => {
  let db: Database;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    db = connectAsAppUser();
    tenantA = await createTenantFixture(db);
    tenantB = await createTenantFixture(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('devolve nome, slug, situação e unidades do PRÓPRIO salão', async () => {
    const summary = await getTenantSummary(db, tenantA.tenantId);
    expect(summary).toMatchObject({ slug: tenantA.slug, status: 'trial' });
    expect(summary?.locations.map((location) => location.id)).toEqual([tenantA.locationId]);
  });

  it('nunca mistura salões: B só vê B (RLS + tenant do contexto)', async () => {
    const summary = await getTenantSummary(db, tenantB.tenantId);
    expect(summary?.slug).toBe(tenantB.slug);
    expect(summary?.locations.map((location) => location.id)).not.toContain(tenantA.locationId);
  });

  it('tenant inexistente (organização sem salão, criação interrompida): null', async () => {
    await expect(getTenantSummary(db, newId())).resolves.toBeNull();
  });
});
