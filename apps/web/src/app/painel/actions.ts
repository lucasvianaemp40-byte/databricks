'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '../../lib/auth/server';

/** Saída: invalida a sessão no servidor e apaga o cookie (ASVS 7.4.1). */
export async function signOutAction(): Promise<void> {
  try {
    await getAuth().api.signOut({ headers: await headers() });
  } catch {
    // Sessão já inexistente ou expirada: o resultado é o mesmo, sair.
  }
  redirect('/entrar');
}
