import { locations, tenants, withTenant } from '@salon/db';
import { asc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppTopBar } from '../../components/app-top-bar';
import { BRAZIL_TIME_ZONES, utcOffsetLabel } from '../../lib/salon/brazil-timezones';
import { requireTenant } from '../../server/auth/session';
import { appDb } from '../../server/db';

export const metadata: Metadata = { title: 'Painel' };

const STATUS_LABELS = {
  trial: 'Teste grátis',
  active: 'Ativo',
  suspended: 'Suspenso',
  closed: 'Encerrado',
} as const;

const NEXT_STEPS = [
  { title: 'Cadastrar serviços', description: 'Corte, escova, coloração: duração e preço.' },
  { title: 'Cadastrar a equipe', description: 'Profissionais, vínculo e comissão padrão.' },
  { title: 'Definir os horários', description: 'Jornada semanal de cada profissional.' },
  { title: 'Divulgar o link', description: 'Instagram, Google e WhatsApp do salão.' },
] as const;

function regionOf(timeZone: string): string {
  return BRAZIL_TIME_ZONES.find((zone) => zone.id === timeZone)?.region ?? timeZone;
}

export default async function DashboardPage() {
  const context = await requireTenant();
  // Só o tenant do vínculo da sessão, pela RLS (withTenant + app_user).
  const data = await withTenant(
    appDb(),
    context.tenantId,
    async (tx) => {
      const [tenant] = await tx
        .select({ name: tenants.name, slug: tenants.slug, status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, context.tenantId));
      const units = await tx
        .select({ id: locations.id, name: locations.name, timezone: locations.timezone })
        .from(locations)
        .where(eq(locations.active, true))
        .orderBy(asc(locations.createdAt));
      return { tenant, units };
    },
    { readOnly: true, actor: { type: 'staff', id: context.user.id } },
  );
  if (data.tenant === undefined) {
    notFound();
  }
  const now = new Date();
  const firstName = context.user.name.split(' ')[0] ?? context.user.name;

  return (
    <>
      <AppTopBar heading={data.tenant.name} userName={context.user.name} />
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <p className="font-semibold text-rose-700 text-sm dark:text-rose-300">Painel</p>
        <h1 className="mt-2 font-bold text-3xl text-zinc-900 tracking-tight dark:text-zinc-50">
          Olá, {firstName}! Seu salão está pronto.
        </h1>
        <p className="mt-2 text-zinc-700 dark:text-zinc-300">
          Agora é só completar a configuração para abrir a agenda online.
        </p>

        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <section
            aria-labelledby="titulo-salao"
            className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="flex items-start justify-between gap-4">
              <h2
                id="titulo-salao"
                className="font-semibold text-lg text-zinc-900 dark:text-zinc-50"
              >
                Salão
              </h2>
              <span className="rounded-full bg-amber-100 px-3 py-1 font-medium text-amber-900 text-xs dark:bg-amber-900/40 dark:text-amber-100">
                {STATUS_LABELS[data.tenant.status]}
              </span>
            </div>
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-zinc-600 dark:text-zinc-400">Nome</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-100">{data.tenant.name}</dd>
              </div>
              <div>
                <dt className="text-zinc-600 dark:text-zinc-400">Página de agendamento</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-100">
                  agendasalao.com.br/{data.tenant.slug}
                </dd>
              </div>
            </dl>
          </section>

          <section
            aria-labelledby="titulo-unidades"
            className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <h2
              id="titulo-unidades"
              className="font-semibold text-lg text-zinc-900 dark:text-zinc-50"
            >
              {data.units.length === 1 ? 'Unidade' : 'Unidades'}
            </h2>
            <ul className="mt-4 space-y-4">
              {data.units.map((unit) => (
                <li key={unit.id} className="text-sm">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">{unit.name}</p>
                  <p className="mt-1 text-zinc-700 dark:text-zinc-300">
                    {regionOf(unit.timezone)} ({utcOffsetLabel(unit.timezone, now)})
                  </p>
                  <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                    Agora na unidade:{' '}
                    {new Intl.DateTimeFormat('pt-BR', {
                      timeZone: unit.timezone,
                      dateStyle: 'full',
                      timeStyle: 'short',
                    }).format(now)}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section aria-labelledby="titulo-proximos" className="mt-10">
          <h2
            id="titulo-proximos"
            className="font-semibold text-lg text-zinc-900 dark:text-zinc-50"
          >
            Próximos passos
          </h2>
          <ol className="mt-4 grid gap-4 sm:grid-cols-2">
            {NEXT_STEPS.map((step, index) => (
              <li
                key={step.title}
                className="flex gap-4 rounded-2xl border border-zinc-200 border-dashed p-5 dark:border-zinc-700"
              >
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 font-semibold text-sm text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                >
                  {index + 1}
                </span>
                <span>
                  <span className="block font-medium text-zinc-900 dark:text-zinc-100">
                    {step.title}
                  </span>
                  <span className="mt-1 block text-sm text-zinc-700 dark:text-zinc-300">
                    {step.description}
                  </span>
                  <span className="mt-2 inline-block rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    Em breve
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
