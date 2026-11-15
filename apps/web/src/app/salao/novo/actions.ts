'use server';

import { createTenantWithFirstLocation, TenantSlugTakenError } from '@salon/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireUser } from '../../../lib/auth/dal';
import { authErrorMessage, SLUG_TAKEN_ERROR } from '../../../lib/auth/messages';
import { getAppDb, getAuth } from '../../../lib/auth/server';
import { createSalonSchema, suggestSlug } from '../../../lib/auth/validation';
import { echoValues, type FormState, fieldErrorsFrom, readFields } from '../../../lib/form-state';

const FIELDS = ['salonName', 'slug', 'locationName', 'timezone'] as const;
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

  let organization: { id: string; name: string; slug: string };
  try {
    // Um salão por conta (organizationLimit: 1): se já existe, é retomada.
    const existing = await auth.api.listOrganizations({ headers: requestHeaders });
    organization =
      existing[0] ??
      (await auth.api.createOrganization({
        body: { name: input.salonName, slug: input.slug },
        headers: requestHeaders,
      }));
  } catch (error) {
    const message = authErrorMessage(error, 'create-salon');
    return message === SLUG_TAKEN_ERROR
      ? { fieldErrors: { slug: message }, values }
      : { message, values };
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
