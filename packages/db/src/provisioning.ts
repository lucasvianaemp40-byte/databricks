import { asc, eq } from 'drizzle-orm';
import type { Database } from './client';
import { isUuid, newId } from './ids';
import {
  authMembers,
  authOrganizations,
  authUsers,
  locations,
  type MemberRole,
  tenants,
} from './schema';
import { withTenant } from './tenant';

/**
 * Provisionamento do salão (onboarding do dono, E1.3 + E2.1).
 *
 * Roda na conexão do papel `app_auth`, a única que grava no schema `auth`. O `app_auth` só
 * INSERE em `app.tenants` e `app.locations` (não lê, não altera, não apaga dado de tenant,
 * migração 0007), e a política RESTRICTIVE de tenant continua valendo: o INSERT só passa
 * com o id do contexto aberto por `withTenant`.
 */

export interface ProvisionTenantInput {
  /** Id do usuário da SESSÃO (Better Auth), nunca vindo do corpo da requisição. */
  readonly ownerUserId: string;
  readonly tenant: { readonly name: string; readonly slug: string };
  readonly location: { readonly name: string; readonly slug: string; readonly timezone: string };
}

export interface ProvisionedTenant {
  readonly tenantId: string;
  readonly locationId: string;
}

/** Dono inexistente ou com e-mail não verificado: não pode criar salão. */
export class OwnerNotEligibleError extends Error {
  readonly code = 'OWNER_NOT_ELIGIBLE';

  constructor() {
    super('Conta não encontrada ou com e-mail não verificado.');
    this.name = new.target.name;
  }
}

/** A conta já tem um salão (nesta iteração, um salão por conta). */
export class TenantAlreadyProvisionedError extends Error {
  readonly code = 'TENANT_ALREADY_PROVISIONED';

  constructor() {
    super('Esta conta já tem um salão.');
    this.name = new.target.name;
  }
}

function parseUserId(userId: string): string {
  if (!isUuid(userId)) {
    throw new TypeError('provisionamento: o id do usuário precisa ser um UUID válido');
  }
  return userId.toLowerCase();
}

/**
 * Cria, numa ÚNICA transação: o tenant (`app.tenants`), a primeira unidade (`app.locations`,
 * com o fuso IANA validado pelo banco), a organização do Better Auth com o MESMO id
 * (`auth.organizations`, FK para o tenant) e o vínculo `owner` (`auth.members`). Ou tudo, ou
 * nada: slug em uso, fuso inválido ou dono inelegível não deixam linha órfã.
 *
 * Um salão por conta: a linha do usuário é travada (`FOR UPDATE`) antes de conferir os
 * vínculos, então dois envios simultâneos da mesma conta se enfileiram e o segundo recebe
 * `TenantAlreadyProvisionedError`. Os ids nascem aqui (`newId()`).
 *
 * Erros: `OwnerNotEligibleError`, `TenantAlreadyProvisionedError`, `SlugUnavailableError`
 * (slug público em uso) e os do banco para dado fora das regras (CHECK 23514).
 */
export async function provisionTenant(
  authDb: Database,
  input: ProvisionTenantInput,
): Promise<ProvisionedTenant> {
  const ownerUserId = parseUserId(input.ownerUserId);
  const tenantId = newId();
  const locationId = newId();

  await withTenant(
    authDb,
    tenantId,
    async (tx) => {
      const [owner] = await tx
        .select({ emailVerified: authUsers.emailVerified })
        .from(authUsers)
        .where(eq(authUsers.id, ownerUserId))
        .for('update');
      if (owner?.emailVerified !== true) {
        throw new OwnerNotEligibleError();
      }
      const existing = await tx
        .select({ id: authMembers.id })
        .from(authMembers)
        .where(eq(authMembers.userId, ownerUserId))
        .limit(1);
      if (existing.length > 0) {
        throw new TenantAlreadyProvisionedError();
      }

      // Sem RETURNING: o app_auth não tem SELECT nas tabelas de tenant.
      await tx
        .insert(tenants)
        .values({ id: tenantId, slug: input.tenant.slug, name: input.tenant.name });
      await tx.insert(locations).values({
        id: locationId,
        name: input.location.name,
        slug: input.location.slug,
        timezone: input.location.timezone,
      });
      await tx
        .insert(authOrganizations)
        .values({ id: tenantId, name: input.tenant.name, slug: input.tenant.slug });
      await tx
        .insert(authMembers)
        .values({ id: newId(), organizationId: tenantId, userId: ownerUserId, role: 'owner' });
    },
    { actor: { type: 'staff', id: ownerUserId } },
  );

  return { tenantId, locationId };
}

export interface Membership {
  readonly tenantId: string;
  readonly role: MemberRole;
}

/**
 * Vínculos de uma pessoa (id da SESSÃO), do mais antigo para o mais novo. É a fonte do
 * `tenantId` do servidor: nunca aceite o tenant vindo da requisição.
 */
export async function listMemberships(authDb: Database, userId: string): Promise<Membership[]> {
  const id = parseUserId(userId);
  return authDb
    .select({ tenantId: authMembers.organizationId, role: authMembers.role })
    .from(authMembers)
    .where(eq(authMembers.userId, id))
    .orderBy(asc(authMembers.createdAt), asc(authMembers.id));
}
