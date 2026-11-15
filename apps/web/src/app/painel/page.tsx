import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { env } from '../../env';
import { requireTenant } from '../../lib/auth/dal';
import { findTenantSummary } from '../../lib/tenant-summary';
import { timeZoneLabel } from '../../lib/time-zones';
import { signOutAction } from './actions';

export const metadata: Metadata = { title: 'Painel do salão' };

const ROLE_LABELS: Readonly<Record<string, string>> = {
  owner: 'Dono',
  admin: 'Gerência',
  member: 'Profissional',
};

const NEXT_STEPS = [
  'Cadastrar os serviços, com duração e preço',
  'Cadastrar os profissionais e a jornada de cada um',
  'Abrir a página de agendamento para os clientes',
];

export default async function DashboardPage() {
  const { user, tenantId, role } = await requireTenant();
  const salon = await findTenantSummary(tenantId);
  if (salon === null) {
    redirect('/salao/novo');
  }
  const publicAddress = `${env.APP_URL.replace(/^https?:\/\//, '')}/${salon.slug}`;

  return (
    <section aria-labelledby="titulo-painel" className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-medium text-rose-700 text-sm uppercase tracking-wide dark:text-rose-300">
            Painel do salão
          </p>
          <h1 id="titulo-painel" className="mt-1 font-bold text-3xl tracking-tight">
            {salon.name}
          </h1>
          <p className="mt-2 text-zinc-700 dark:text-zinc-300">
            Olá, {user.name} ({ROLE_LABELS[role] ?? role}).
          </p>
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-4 py-2 font-medium text-sm hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Sair
          </button>
        </form>
      </div>

      <dl className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <dt className="text-sm text-zinc-600 dark:text-zinc-400">Situação</dt>
          <dd className="mt-1 font-semibold">
            {salon.status === 'trial' ? 'Período de teste' : salon.status}
          </dd>
        </div>
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <dt className="text-sm text-zinc-600 dark:text-zinc-400">Página de agendamento</dt>
          <dd className="mt-1 break-all font-semibold">{publicAddress}</dd>
          <dd className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Disponível em breve</dd>
        </div>
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <dt className="text-sm text-zinc-600 dark:text-zinc-400">Unidades</dt>
          <dd className="mt-1 font-semibold">{salon.locations.length}</dd>
        </div>
      </dl>

      <h2 className="mt-10 font-bold text-xl tracking-tight">Unidades</h2>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2">
        {salon.locations.map((location) => (
          <li
            key={location.id}
            className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <p className="font-semibold">{location.name}</p>
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
              Fuso: {timeZoneLabel(location.timezone)}
            </p>
          </li>
        ))}
      </ul>

      <h2 className="mt-10 font-bold text-xl tracking-tight">Próximos passos</h2>
      <ol className="mt-4 list-decimal space-y-2 pl-6 text-zinc-700 dark:text-zinc-300">
        {NEXT_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </section>
  );
}
