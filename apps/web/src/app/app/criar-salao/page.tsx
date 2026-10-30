import type { Metadata } from 'next';
import { AppTopBar } from '../../../components/app-top-bar';
import { DEFAULT_TIME_ZONE, timeZoneOptions } from '../../../lib/salon/brazil-timezones';
import { requireUserWithoutTenant } from '../../../server/auth/session';
import { CreateSalonForm } from './create-salon-form';

export const metadata: Metadata = { title: 'Criar salão' };

const STEPS = ['Conta', 'Salão e unidade', 'Pronto'] as const;

export default async function CreateSalonPage() {
  const user = await requireUserWithoutTenant();
  return (
    <>
      <AppTopBar heading="Configuração inicial" userName={user.name} />
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
        <nav aria-label="Etapas do cadastro">
          <ol className="flex items-center gap-2 text-sm">
            {STEPS.map((step, index) => {
              const done = index === 0;
              const current = index === 1;
              return (
                <li key={step} className="flex items-center gap-2">
                  <span
                    aria-current={current ? 'step' : undefined}
                    className={`flex items-center gap-2 rounded-full px-3 py-1 font-medium ${
                      current
                        ? 'bg-rose-700 text-white dark:bg-rose-600'
                        : done
                          ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200'
                          : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}
                  >
                    {done ? <span aria-hidden="true">✓</span> : null}
                    {step}
                    {done ? <span className="sr-only"> (concluída)</span> : null}
                  </span>
                  {index < STEPS.length - 1 ? (
                    <span aria-hidden="true" className="text-zinc-400">
                      →
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </nav>
        <h1 className="mt-8 font-bold text-3xl text-zinc-900 tracking-tight dark:text-zinc-50">
          Cadastre seu salão
        </h1>
        <p className="mt-2 text-zinc-700 dark:text-zinc-300">
          Olá, {user.name}! Conte como o salão se chama e onde fica a primeira unidade. Você pode
          adicionar outras unidades depois.
        </p>
        <div className="mt-8">
          <CreateSalonForm
            timeZones={timeZoneOptions(new Date())}
            defaultTimeZone={DEFAULT_TIME_ZONE}
          />
        </div>
      </div>
    </>
  );
}
