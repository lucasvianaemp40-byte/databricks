'use server';

import { createTenantWithFirstLocation, TenantSlugTakenError } from '@salon/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getActiveMembership, requireUser } from '../../../lib/auth/dal';
import { authErrorMessage, SLUG_TAKEN_ERROR } from '../../../lib/auth/messages';
import { getAppDb, getAuth } from '../../../lib/auth/server';
import { createSalonSchema, suggestSlug } from '../../../lib/auth/validation';
import { echoValues, type FormState, fieldErrorsFrom, readFields } from '../../../lib/form-state';
import { findTenantSummary } from '../../../lib/tenant-summary';

const FIELDS = ['salonName', 'slug', 'locationName', 'timezone'] as const;
const NOT_OWNER_ERROR = 'Só o dono do salão pode concluir este cadastro.';
export type CreateSalonField = (typeof FIELDS)[number];

/**
 * Cria o salão (E1.3): organização do Better Auth (o dono vira `owner`) e, com o MESMO id,
 * o tenant e a primeira unidade. Retoma uma criação que parou no meio (threat model A7): se a
 * conta já tem organização, só completa o tenant. Nada vem do cliente além dos 4 campos.
 */
export async function createSalonAction(
  _previous: FormState<CreateSalonField>,
  formData: FormData,
): Promise<FormState<CreateSalonField>> {
  const user = await requireUser();
  const raw = readFields(formData, FIELDS);
  const values = echoValues(raw);
  const parsed = createSalonSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error), values };
  }
  const input = parsed.data;
  const auth = getAuth();
  const requestHeaders = await headers();

  // Reenvio da action (o id dela está no bundle): salão completo não é recriado nem ganha
  // unidade; só o owner retoma uma criação interrompida (threat model A6 e A7).
  const membership = await getActiveMembership();
  if (membership !== null) {
    if (membership.role !== 'owner') {
      return { message: NOT_OWNER_ERROR, values };
    }
    if ((await findTenantSummary(membership.tenantId)) !== null) {
      redirect('/painel');
    }
  }

  let organization: { id: string; name: string; slug: string };
  try {
    // Um salão por conta (organizationLimit: 1): se já existe, é retomada.
    const existing = await auth.api.listOrganizations({ headers: requestHeaders });
    const current = existing[0];
    if (current !== undefined && current.id !== membership?.tenantId) {
      // Organização que não é a ativa de um owner: não retoma (estado inesperado).
      return { message: NOT_OWNER_ERROR, values };
    }
    organization =
      current ??
      (await auth.api.createOrganization({
        body: { name: input.salonName, slug: input.slug },
        headers: requestHeaders,
      }));
  } catch (error) {
    // Envio simultâneo da mesma conta: o banco recusa o segundo vínculo (um salão por conta),
    // e quem perdeu retoma o salão que o outro envio criou. A organização sem membro que o
    // Better Auth deixa para trás fica com o endereço reservado até a limpeza (pendência).
    const winner = await auth.api
      .listOrganizations({ headers: requestHeaders })
      .then((list) => list[0])
      .catch(() => undefined);
    if (winner === undefined) {
      const message = authErrorMessage(error, 'create-salon');
      return message === SLUG_TAKEN_ERROR
        ? { fieldErrors: { slug: message }, values }
        : { message, values };
    }
    organization = winner;
  }

  try {
    await createTenantWithFirstLocation(
      getAppDb(),
      {
        tenantId: organization.id,
        name: organization.name,
        slug: organization.slug,
        location: {
          name: input.locationName,
          slug: suggestSlug(input.locationName) || 'principal',
          timezone: input.timezone,
        },
      },
      { actor: { type: 'staff', id: user.id } },
    );
    await auth.api.setActiveOrganization({
      body: { organizationId: organization.id },
      headers: requestHeaders,
    });
  } catch (error) {
    if (error instanceof TenantSlugTakenError) {
      return { fieldErrors: { slug: SLUG_TAKEN_ERROR }, values };
    }
    return { message: authErrorMessage(error, 'create-salon'), values };
  }
  redirect('/painel');
}
