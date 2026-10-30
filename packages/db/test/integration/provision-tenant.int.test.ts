import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/client';
import { IdentifierConflictError, PG_ERROR, SlugUnavailableError } from '../../src/errors';
import { newId } from '../../src/ids';
import {
  listMemberships,
  OwnerNotEligibleError,
  type ProvisionTenantInput,
  provisionTenant,
  TenantAlreadyProvisionedError,
} from '../../src/provisioning';
import { authMembers, authOrganizations, authUsers, locations, tenants } from '../../src/schema';
import { withTenant } from '../../src/tenant';
import {
  captureSqlState,
  connectAsAdmin,
  connectAsAppUser,
  connectAsAuth,
} from '../helpers/connections';

/** Pessoa de teste gravada como o Better Auth grava (id UUIDv4, e-mail em minúsculas). */
async function createUser(
  authDb: Database,
  options: { readonly emailVerified?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await authDb.insert(authUsers).values({
    id,
    name: 'Dona do Salão',
    email: `dona-${randomBytes(6).toString('hex')}@exemplo.test`,
    emailVerified: options.emailVerified ?? true,
  });
  return id;
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

function input(ownerUserId: string, slug = uniqueSlug('salao')): ProvisionTenantInput {
  return {
    ownerUserId,
    tenant: { name: 'Salão Bela Vista', slug },
    location: { name: 'Unidade Centro', slug: 'unidade-centro', timezone: 'America/Manaus' },
  };
}

describe('provisionTenant: salão, primeira unidade, organização e dono numa transação', () => {
  let authDb: Database;
  let appDb: Database;
  let admin: pg.Pool;

  beforeAll(() => {
    authDb = connectAsAuth();
    appDb = connectAsAppUser();
    admin = connectAsAdmin();
  });

  afterAll(async () => {
    await Promise.all([authDb.$client.end(), appDb.$client.end(), admin.end()]);
  });

  /** Contagens vistas pelo superusuário (ignora a RLS): prova que nada ficou pela metade. */
  async function countsForOwner(ownerUserId: string) {
    const { rows } = await admin.query<{ members: number }>(
      'SELECT (SELECT count(*)::int FROM auth.members WHERE user_id = $1) AS members',
      [ownerUserId],
    );
    return rows[0];
  }

  async function countRows(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await admin.query<{ n: number }>(sql, params);
    return rows[0]?.n ?? -1;
  }

  it('cria tenant, unidade com o fuso escolhido, organização com o MESMO id e o vínculo owner', async () => {
    const owner = await createUser(authDb);
    const request = input(owner);
    const result = await provisionTenant(authDb, request);

    const [tenant] = await withTenant(
      appDb,
      result.tenantId,
      (tx) => tx.select().from(tenants).where(eq(tenants.id, result.tenantId)),
      { readOnly: true },
    );
    expect(tenant).toMatchObject({
      id: result.tenantId,
      name: 'Salão Bela Vista',
      slug: request.tenant.slug,
      status: 'trial',
    });
    const units = await withTenant(appDb, result.tenantId, (tx) => tx.select().from(locations), {
      readOnly: true,
    });
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      id: result.locationId,
      tenantId: result.tenantId,
      name: 'Unidade Centro',
      slug: 'unidade-centro',
      timezone: 'America/Manaus',
    });

    const [organization] = await authDb
      .select()
      .from(authOrganizations)
      .where(eq(authOrganizations.id, result.tenantId));
    expect(organization).toMatchObject({ name: 'Salão Bela Vista', slug: request.tenant.slug });
    expect(await listMemberships(authDb, owner)).toEqual([
      { tenantId: result.tenantId, role: 'owner' },
    ]);
  });

  it('o salão de A fica invisível e inalterável para o contexto de B (e vice-versa)', async () => {
    const a = await provisionTenant(authDb, input(await createUser(authDb)));
    const b = await provisionTenant(authDb, input(await createUser(authDb)));

    const seenByB = await withTenant(appDb, b.tenantId, async (tx) => ({
      tenants: await tx.select().from(tenants).where(eq(tenants.id, a.tenantId)),
      locations: await tx.select().from(locations).where(eq(locations.id, a.locationId)),
    }));
    expect(seenByB).toEqual({ tenants: [], locations: [] });

    const changed = await withTenant(appDb, b.tenantId, (tx) =>
      tx
        .update(locations)
        .set({ name: 'Invadida' })
        .where(eq(locations.id, a.locationId))
        .returning({ id: locations.id }),
    );
    expect(changed).toEqual([]);
    const [unit] = await withTenant(appDb, a.tenantId, (tx) =>
      tx.select().from(locations).where(eq(locations.id, a.locationId)),
    );
    expect(unit?.name).toBe('Unidade Centro');
  });

  it('as memberships de uma pessoa não incluem salões de outras', async () => {
    const ownerA = await createUser(authDb);
    const ownerB = await createUser(authDb);
    const a = await provisionTenant(authDb, input(ownerA));
    await provisionTenant(authDb, input(ownerB));
    expect(await listMemberships(authDb, ownerA)).toEqual([
      { tenantId: a.tenantId, role: 'owner' },
    ]);
    expect(await listMemberships(authDb, await createUser(authDb))).toEqual([]);
  });

  it('recusa dono com e-mail não verificado ou inexistente, sem gravar nada', async () => {
    const unverified = await createUser(authDb, { emailVerified: false });
    const slug = uniqueSlug('nao-verificado');
    await expect(provisionTenant(authDb, input(unverified, slug))).rejects.toBeInstanceOf(
      OwnerNotEligibleError,
    );
    await expect(provisionTenant(authDb, input(randomUUID()))).rejects.toBeInstanceOf(
      OwnerNotEligibleError,
    );
    expect(await countsForOwner(unverified)).toMatchObject({ members: 0 });
    expect(
      await countRows('SELECT count(*)::int AS n FROM app.tenants WHERE slug = $1', [slug]),
    ).toBe(0);
  });

  it('recusa id de dono que não é UUID antes de tocar no banco', async () => {
    await expect(provisionTenant(authDb, input('1 OR 1=1'))).rejects.toBeInstanceOf(TypeError);
  });

  it('um salão por conta: o segundo provisionamento é recusado e nada novo é gravado', async () => {
    const owner = await createUser(authDb);
    await provisionTenant(authDb, input(owner));
    const secondSlug = uniqueSlug('segundo');
    await expect(provisionTenant(authDb, input(owner, secondSlug))).rejects.toBeInstanceOf(
      TenantAlreadyProvisionedError,
    );
    expect(await countsForOwner(owner)).toMatchObject({ members: 1 });
    expect(
      await countRows('SELECT count(*)::int AS n FROM app.tenants WHERE slug = $1', [secondSlug]),
    ).toBe(0);
  });

  it('dois provisionamentos simultâneos da mesma conta: exatamente um vence', async () => {
    const owner = await createUser(authDb);
    const results = await Promise.allSettled([
      provisionTenant(authDb, input(owner)),
      provisionTenant(authDb, input(owner)),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      TenantAlreadyProvisionedError,
    );
    expect(await countsForOwner(owner)).toMatchObject({ members: 1 });
  });

  it('endereço (slug) já usado por outro salão: SlugUnavailableError, sem organização nem unidade órfã', async () => {
    const slug = uniqueSlug('disputado');
    await provisionTenant(authDb, input(await createUser(authDb), slug));
    const late = await createUser(authDb);
    await expect(provisionTenant(authDb, input(late, slug))).rejects.toBeInstanceOf(
      SlugUnavailableError,
    );
    expect(await countsForOwner(late)).toMatchObject({ members: 0 });
    expect(
      await countRows('SELECT count(*)::int AS n FROM app.tenants WHERE slug = $1', [slug]),
    ).toBe(1);
    expect(
      await countRows('SELECT count(*)::int AS n FROM auth.organizations WHERE slug = $1', [slug]),
    ).toBe(1);
  });

  it('fuso fora do formato IANA Area/Local (UTC, offset fixo) é recusado pelo banco, sem gravar nada', async () => {
    for (const timezone of ['UTC', 'Etc/GMT+3', '-03:00']) {
      const owner = await createUser(authDb);
      const slug = uniqueSlug('fuso');
      const request = input(owner, slug);
      expect(
        await captureSqlState(
          provisionTenant(authDb, { ...request, location: { ...request.location, timezone } }),
        ),
        timezone,
      ).toBe(PG_ERROR.checkViolation);
      expect(
        await countRows('SELECT count(*)::int AS n FROM app.tenants WHERE slug = $1', [slug]),
      ).toBe(0);
    }
  });
});

describe('app_auth: só insere em app.tenants e app.locations, nunca lê dado de tenant', () => {
  let authDb: Database;
  let appDb: Database;

  beforeAll(() => {
    authDb = connectAsAuth();
    appDb = connectAsAppUser();
  });

  afterAll(async () => {
    await Promise.all([authDb.$client.end(), appDb.$client.end()]);
  });

  it('não lê tenants, unidades nem clientes, nem dentro do contexto do próprio tenant', async () => {
    const { tenantId } = await provisionTenant(authDb, input(await createUser(authDb)));
    for (const table of ['app.tenants', 'app.locations', 'app.customers', 'app.appointments']) {
      expect(
        await captureSqlState(
          withTenant(authDb, tenantId, (tx) => tx.execute(`SELECT 1 FROM ${table} LIMIT 1`)),
        ),
        table,
      ).toBe(PG_ERROR.insufficientPrivilege);
    }
  });

  it('não altera nem apaga o salão criado', async () => {
    const { tenantId } = await provisionTenant(authDb, input(await createUser(authDb)));
    for (const statement of ["UPDATE app.tenants SET name = 'x'", 'DELETE FROM app.locations']) {
      expect(
        await captureSqlState(withTenant(authDb, tenantId, (tx) => tx.execute(statement))),
        statement,
      ).toBe(PG_ERROR.insufficientPrivilege);
    }
  });

  it('não insere tenant com id diferente do contexto (RLS RESTRICTIVE continua valendo)', async () => {
    const context = newId();
    expect(
      await captureSqlState(
        withTenant(authDb, context, (tx) =>
          tx.insert(tenants).values({ id: newId(), slug: uniqueSlug('forjado'), name: 'Forjado' }),
        ),
      ),
    ).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('com o contexto de B, não insere unidade no tenant A (RESTRICTIVE pelo tenant_id)', async () => {
    const a = await provisionTenant(authDb, input(await createUser(authDb)));
    const b = await provisionTenant(authDb, input(await createUser(authDb)));
    expect(
      await captureSqlState(
        withTenant(authDb, b.tenantId, (tx) =>
          tx.insert(locations).values({
            tenantId: a.tenantId,
            name: 'Intrusa',
            slug: 'intrusa',
            timezone: 'America/Sao_Paulo',
          }),
        ),
      ),
    ).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('id de tenant que já existe aborta tudo (PK global), sem organização nem vínculo', async () => {
    const existing = await provisionTenant(authDb, input(await createUser(authDb)));
    const intruder = await createUser(authDb);
    await expect(
      withTenant(authDb, existing.tenantId, async (tx) => {
        await tx
          .insert(tenants)
          .values({ id: existing.tenantId, slug: uniqueSlug('roubo'), name: 'Roubo' });
        await tx.insert(authMembers).values({
          id: randomUUID(),
          organizationId: existing.tenantId,
          userId: intruder,
          role: 'owner',
        });
      }),
    ).rejects.toBeInstanceOf(IdentifierConflictError);
    expect(await listMemberships(authDb, intruder)).toEqual([]);
  });

  it('não cria salão já ativo: a política de provisionamento exige status trial', async () => {
    const tenantId = newId();
    expect(
      await captureSqlState(
        withTenant(authDb, tenantId, (tx) =>
          tx
            .insert(tenants)
            .values({ id: tenantId, slug: uniqueSlug('ativo'), name: 'Ativo', status: 'active' }),
        ),
      ),
    ).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('não insere em outras tabelas de tenant nem cria objetos (schema app ou auth)', async () => {
    const { tenantId } = await provisionTenant(authDb, input(await createUser(authDb)));
    for (const statement of [
      "INSERT INTO app.customers (full_name, phone_e164) VALUES ('Cliente', '+5511999990000')",
      "INSERT INTO app.staff (display_name, engagement_type) VALUES ('Profissional', 'employee')",
      'CREATE TABLE auth.x (id int)',
      'CREATE TABLE app.x (id int)',
    ]) {
      expect(
        await captureSqlState(withTenant(authDb, tenantId, (tx) => tx.execute(statement))),
        statement,
      ).toBe(PG_ERROR.insufficientPrivilege);
    }
  });

  it('não cria organização sem tenant correspondente (FK no id)', async () => {
    expect(
      await captureSqlState(
        authDb
          .insert(authOrganizations)
          .values({ id: newId(), name: 'Sem tenant', slug: uniqueSlug('sem-tenant') }),
      ),
    ).toBe(PG_ERROR.foreignKeyViolation);
  });

  it('app_user não lê nem grava no schema auth (usuários, sessões, vínculos)', async () => {
    const { tenantId } = await provisionTenant(authDb, input(await createUser(authDb)));
    for (const statement of [
      'SELECT 1 FROM auth.users LIMIT 1',
      'SELECT 1 FROM auth.sessions LIMIT 1',
      'SELECT 1 FROM auth.members LIMIT 1',
      `INSERT INTO auth.members (id, organization_id, user_id, role)
         VALUES (gen_random_uuid(), '${tenantId}', gen_random_uuid(), 'owner')`,
    ]) {
      expect(
        await captureSqlState(withTenant(appDb, tenantId, (tx) => tx.execute(statement))),
        statement,
      ).toBe(PG_ERROR.insufficientPrivilege);
    }
  });

  it('o vínculo do dono não pode ser duplicado nem ganhar papel fora da lista', async () => {
    const owner = await createUser(authDb);
    const { tenantId } = await provisionTenant(authDb, input(owner));
    expect(
      await captureSqlState(
        authDb
          .insert(authMembers)
          .values({ id: randomUUID(), organizationId: tenantId, userId: owner, role: 'owner' }),
      ),
    ).toBe(PG_ERROR.uniqueViolation);
    expect(
      await captureSqlState(
        authDb.execute(
          `INSERT INTO auth.members (id, organization_id, user_id, role)
             VALUES (gen_random_uuid(), '${tenantId}', '${await createUser(authDb)}', 'superadmin')`,
        ),
      ),
    ).toBe(PG_ERROR.checkViolation);
  });
});
