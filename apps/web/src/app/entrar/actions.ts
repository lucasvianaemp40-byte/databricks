'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { authErrorMessage } from '../../lib/auth/messages';
import { getAuth } from '../../lib/auth/server';
import { signInSchema } from '../../lib/auth/validation';
import { echoValues, type FormState, readFields } from '../../lib/form-state';

const FIELDS = ['email', 'password'] as const;
export type SignInField = (typeof FIELDS)[number];

/** Login com e-mail e senha: sessão nova a cada login (ASVS 7.2.4). */
export async function signInAction(
  _previous: FormState<SignInField>,
  formData: FormData,
): Promise<FormState<SignInField>> {
  const raw = readFields(formData, FIELDS);
  const values = echoValues(raw, ['password']);
  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) {
    // Mesma mensagem do erro de credencial: o formato não vira pista (threat model A8).
    return { message: authErrorMessage(undefined, 'sign-in'), values };
  }
  try {
    await getAuth().api.signInEmail({ body: parsed.data, headers: await headers() });
  } catch (error) {
    return { message: authErrorMessage(error, 'sign-in'), values };
  }
  redirect('/painel');
}
