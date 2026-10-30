'use server';

import { provisionTenant } from '@salon/db';
import { redirect } from 'next/navigation';
import { requireUser } from '../../../server/auth/session';
import { authDb } from '../../../server/db';
import { type CreateSalonState, createSalonFromForm } from '../../../server/salon/create-salon';

/**
 * Cria o salão e a primeira unidade. A sessão é relida aqui (a action é um endpoint público);
 * o dono é sempre a pessoa da sessão. Origem cruzada é recusada pela checagem nativa do Next.
 */
export async function createSalonAction(
  _previous: CreateSalonState,
  formData: FormData,
): Promise<CreateSalonState> {
  const user = await requireUser();
  const outcome = await createSalonFromForm({
    ownerUserId: user.id,
    formData,
    provision: (input) => provisionTenant(authDb(), input),
    logFailure: (description) => {
      console.error(`[criar-salao] falha ao provisionar: ${description}`);
    },
  });
  if (outcome.kind === 'not-eligible') {
    redirect('/entrar');
  }
  if (outcome.kind === 'invalid') {
    return outcome.state;
  }
  // Criado agora, ou a conta já tinha salão: o painel.
  redirect('/app');
}
