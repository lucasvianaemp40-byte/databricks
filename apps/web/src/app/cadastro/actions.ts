'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { authErrorMessage, TOO_MANY_ATTEMPTS } from '../../lib/auth/messages';
import { authLimits, clientIp } from '../../lib/auth/rate-limit';
import { getAuth } from '../../lib/auth/server';
import { signUpSchema } from '../../lib/auth/validation';
import { echoValues, type FormState, fieldErrorsFrom, readFields } from '../../lib/form-state';

const FIELDS = ['name', 'email', 'password'] as const;
export type SignUpField = (typeof FIELDS)[number];

/** Cadastro do dono (E1.1, 1ª entrega). Sessão nova no sucesso; depois, criar o salão. */
export async function signUpAction(
  _previous: FormState<SignUpField>,
  formData: FormData,
): Promise<FormState<SignUpField>> {
  const raw = readFields(formData, FIELDS);
  const values = echoValues(raw, ['password']);
  const parsed = signUpSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error), values };
  }
  const requestHeaders = await headers();
  // Cadastro em massa custa scrypt e enche o banco (threat model A13).
  if (!authLimits.signUpByIp.hit(`ip:${clientIp(requestHeaders)}`)) {
    return { message: TOO_MANY_ATTEMPTS, values };
  }
  try {
    await getAuth().api.signUpEmail({ body: parsed.data, headers: requestHeaders });
  } catch (error) {
    return { message: authErrorMessage(error, 'sign-up'), values };
  }
  redirect('/salao/novo');
}
