'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { authErrorMessage } from '../../lib/auth/messages';
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
  try {
    await getAuth().api.signUpEmail({ body: parsed.data, headers: await headers() });
  } catch (error) {
    return { message: authErrorMessage(error, 'sign-up'), values };
  }
  redirect('/salao/novo');
}
