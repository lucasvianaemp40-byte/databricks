import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { env } from '../../../env';
import { getActiveMembership, requireUser } from '../../../lib/auth/dal';
import { findTenantSummary } from '../../../lib/tenant-summary';
import { CreateSalonForm } from './create-salon-form';

export const metadata: Metadata = { title: 'Criar salão' };

export default async function CreateSalonPage() {
  const user = await requireUser();
  const membership = await getActiveMembership();
  // Salão completo: nada a criar. Organização sem tenant (criação interrompida): o formulário retoma.
  if (membership !== null && (await findTenantSummary(membership.tenantId)) !== null) {
    redirect('/painel');
  }
  return (
    <section aria-labelledby="titulo-salao" className="mx-auto max-w-lg px-4 py-12 sm:px-6">
      <h1 id="titulo-salao" className="font-bold text-3xl tracking-tight">
        Cadastre seu salão
      </h1>
      <p className="mt-2 text-zinc-700 dark:text-zinc-300">
        Olá, {user.name}. Falta pouco: diga o nome do salão e da primeira unidade.
      </p>
      <CreateSalonForm origin={env.APP_URL} />
    </section>
  );
}
