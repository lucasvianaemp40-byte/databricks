import type { ReactNode } from 'react';

const HIGHLIGHTS = [
  {
    title: 'Agenda aberta 24 horas',
    description: 'Seus clientes marcam pelo celular, sem esperar resposta no WhatsApp.',
  },
  {
    title: 'Sem encaixe que se sobrepõe',
    description: 'Cada profissional só aparece livre quando tem tempo para o serviço inteiro.',
  },
  {
    title: 'Dados protegidos',
    description: 'Os dados de cada salão ficam separados dos demais.',
  },
] as const;

/**
 * Telas de acesso: formulário à esquerda e, no desktop, um painel da marca à direita
 * (gradiente e padrão em CSS, sem foto nem fonte de terceiros).
 */
export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16 lg:py-20">
      <div className="flex justify-center lg:justify-start">
        <div className="w-full max-w-md">{children}</div>
      </div>
      <aside
        aria-label="Por que usar o Agenda Salão"
        className="relative hidden overflow-hidden rounded-3xl bg-linear-to-br from-rose-50 via-white to-amber-50 p-10 ring-1 ring-zinc-200 lg:block dark:from-rose-950/40 dark:via-zinc-900 dark:to-amber-950/30 dark:ring-zinc-800"
      >
        <div
          aria-hidden="true"
          className="absolute -top-24 -right-24 size-72 rounded-full bg-rose-200/50 blur-3xl dark:bg-rose-800/20"
        />
        <div
          aria-hidden="true"
          className="absolute -bottom-28 -left-16 size-72 rounded-full bg-amber-200/50 blur-3xl dark:bg-amber-700/10"
        />
        <div className="relative">
          <p className="font-semibold text-rose-700 text-sm uppercase tracking-wider dark:text-rose-300">
            Para salões e barbearias
          </p>
          <p className="mt-4 text-balance font-bold text-3xl text-zinc-900 tracking-tight dark:text-zinc-50">
            A agenda do seu salão organizada em poucos minutos.
          </p>
          <ul className="mt-10 space-y-6">
            {HIGHLIGHTS.map((item) => (
              <li key={item.title} className="flex gap-4">
                <span
                  aria-hidden="true"
                  className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-rose-700 font-bold text-sm text-white dark:bg-rose-600"
                >
                  ✓
                </span>
                <span>
                  <span className="block font-semibold text-zinc-900 dark:text-zinc-50">
                    {item.title}
                  </span>
                  <span className="mt-1 block text-zinc-700 dark:text-zinc-300">
                    {item.description}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
