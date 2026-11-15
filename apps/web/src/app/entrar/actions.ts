'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { authErrorMessage, TOO_MANY_ATTEMPTS } from '../../lib/auth/messages';
import { allowSignIn, authLimits, clientIp } from '../../lib/auth/rate-limit';
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
  const requestHeaders = await headers();
  // Por IP, por (e-mail, IP) e teto global por e-mail (threat model A2).
  if (!allowSignIn(authLimits, parsed.data.email, clientIp(requestHeaders))) {
    return { message: TOO_MANY_ATTEMPTS, values };
  }
  try {
    await getAuth().api.signInEmail({ body: parsed.data, headers: requestHeaders });
  } catch (error) {
    return { message: authErrorMessage(error, 'sign-in'), values };
  }
  redirect('/painel');
}
