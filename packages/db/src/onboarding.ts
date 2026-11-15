import { asc, eq } from 'drizzle-orm';
import type { Database } from './client';
import { locations, tenants } from './schema';
import { type WithTenantOptions, withTenant } from './tenant';

/** Salão novo com a primeira unidade (história E1.3). */
export interface NewTenantInput {
  /** Id da organização do Better Auth: o tenant usa o MESMO id (ADR-0004). */
  readonly tenantId: string;
  readonly name: string;
  /** Endereço público (URL da página de agendamento), único entre todos os salões. */
  readonly slug: string;
  readonly location: {
    readonly name: string;
    readonly slug: string;
    /** Fuso IANA da unidade (o banco confere contra o tzdata). */
    readonly timezone: string;
  };
}

export interface CreatedTenant {
  readonly tenantId: string;
  readonly locationId: string;
}

/**
 * O id pedido já é de um salão com outros dados (outro slug ou nome). Não acontece no fluxo
 * normal, em que o id vem da organização recém-criada; é a guarda contra reaproveitar o
 * salão de outra pessoa por engano. HTTP sugerido: 409 genérico.
 */
export class TenantOnboardingConflictError extends Error {
  readonly code = 'TENANT_ONBOARDING_CONFLICT';

  constructor() {
    super('Não foi possível criar o salão: salão já existe com outros dados.');
    this.name = new.target.name;
  }
}

/**
 * Cria o salão (`app.tenants`, em `trial`) e a primeira unidade numa transação só, no
 * contexto do próprio tenant (a RLS confere o id). Idempotente para retomar uma criação que
 * falhou no meio: repetir com os mesmos dados devolve os mesmos ids sem duplicar. Slug em uso
 * por outro salão vira `TenantSlugTakenError` e nada é gravado.
 *
 * O `tenantId` vem SEMPRE da organização criada no servidor para a sessão, nunca do cliente.
 */
export async function createTenantWithFirstLocation(
  db: Database,
  input: NewTenantInput,
  options: WithTenantOptions = {},
): Promise<CreatedTenant> {
  return withTenant(
    db,
    input.tenantId,
    async (tx) => {
      await tx
        .insert(tenants)
        .values({ id: input.tenantId, slug: input.slug, name: input.name })
        .onConflictDoNothing({ target: tenants.id });
      const [tenant] = await tx
        .select({ slug: tenants.slug, name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId));
      if (tenant === undefined || tenant.slug !== input.slug || tenant.name !== input.name) {
        throw new TenantOnboardingConflictError();
      }

      // Só a PRIMEIRA unidade nasce aqui: retomar com a mesma unidade devolve a existente;
      // um reenvio com outra unidade num salão que já tem unidade é recusado (unidade nova
      // é outra funcionalidade, com autorização própria).
      const existing = await tx
        .select({ id: locations.id, slug: locations.slug })
        .from(locations)
        .where(eq(locations.tenantId, input.tenantId));
      if (existing.length > 0) {
        const same = existing.find((location) => location.slug === input.location.slug);
        if (same === undefined) {
          throw new TenantOnboardingConflictError();
        }
        return { tenantId: input.tenantId, locationId: same.id };
      }
      const [location] = await tx
        .insert(locations)
        .values({
          name: input.location.name,
          slug: input.location.slug,
          timezone: input.location.timezone,
        })
        .returning({ id: locations.id });
      if (location === undefined) {
        throw new TenantOnboardingConflictError();
      }
      return { tenantId: input.tenantId, locationId: location.id };
    },
    options,
  );
}

export interface TenantSummary {
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly locations: readonly {
    readonly id: string;
    readonly name: string;
    readonly timezone: string;
  }[];
}

/**
 * Resumo do salão para o painel, lido no contexto do próprio tenant (RLS). `null` quando o
 * tenant ainda não existe: organização criada, criação do salão interrompida (retomada).
 */
export async function getTenantSummary(
  db: Database,
  tenantId: string,
): Promise<TenantSummary | null> {
  return withTenant(
    db,
    tenantId,
    async (tx) => {
      const [tenant] = await tx
        .select({ name: tenants.name, slug: tenants.slug, status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      if (tenant === undefined) {
        return null;
      }
      const rows = await tx
        .select({ id: locations.id, name: locations.name, timezone: locations.timezone })
        .from(locations)
        .orderBy(asc(locations.createdAt), asc(locations.id));
      return { ...tenant, locations: rows };
    },
    { readOnly: true },
  );
}
