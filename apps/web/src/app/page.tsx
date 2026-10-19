import type { AppointmentStatus } from '@salon/scheduling-core';
import type { Metadata } from 'next';
import { appointmentStatusLabel } from '../lib/appointment-status-labels';

export const metadata: Metadata = {
  // URL canônica absoluta, resolvida contra o metadataBase (APP_URL, lida em runtime).
  alternates: { canonical: '/' },
};

interface Feature {
  readonly title: string;
  readonly description: string;
}

const FEATURES: readonly Feature[] = [
  {
    title: 'Agendamento a qualquer hora',
    description:
      'O cliente escolhe o serviço, o profissional e o horário pelo celular, sem precisar ligar nem esperar resposta no WhatsApp.',
  },
  {
    title: 'Agenda sem conflitos',
    description:
      'Cada profissional só aparece livre quando tem tempo para o serviço inteiro, inclusive pausas como a de uma coloração.',
  },
  {
    title: 'Cada unidade no seu fuso',
    description:
      'Horários sempre no fuso da unidade, do Acre a Fernando de Noronha, inclusive para quem agenda de outro estado.',
  },
  {
    title: 'Privacidade desde o início',
    description:
      'Dados dos clientes tratados conforme a LGPD, com os dados de cada salão separados dos demais.',
  },
];

/** Etapas mostradas ao visitante; os rótulos vêm do mapa exaustivo de status do domínio. */
const JOURNEY: readonly AppointmentStatus[] = ['pending', 'confirmed', 'in_service', 'completed'];

export default function HomePage() {
  return (
    <>
      <section
        aria-labelledby="titulo-principal"
        className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24"
      >
        <p className="font-medium text-rose-700 text-sm uppercase tracking-wide dark:text-rose-300">
          Para salões de beleza e barbearias
        </p>
        <h1
          id="titulo-principal"
          className="mt-3 max-w-3xl text-balance font-bold text-4xl tracking-tight sm:text-5xl"
        >
          A agenda do seu salão, aberta 24 horas
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-pretty text-zinc-700 dark:text-zinc-300">
          Seus clientes marcam horário sozinhos e sua equipe acompanha o dia em um só lugar, sem
          encaixes que se sobrepõem nem recados perdidos.
        </p>
        <p className="mt-8 inline-flex rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
          Em desenvolvimento: lançamento em breve.
        </p>
      </section>

      <section
        aria-labelledby="titulo-recursos"
        className="border-zinc-200 border-t bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
          <h2 id="titulo-recursos" className="font-bold text-2xl tracking-tight">
            Feito para a rotina do salão
          </h2>
          <ul className="mt-8 grid gap-8 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <li key={feature.title}>
                <h3 className="font-semibold text-lg">{feature.title}</h3>
                <p className="mt-2 text-zinc-700 dark:text-zinc-300">{feature.description}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="titulo-jornada" className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
        <h2 id="titulo-jornada" className="font-bold text-2xl tracking-tight">
          Cada atendimento, do pedido ao fim
        </h2>
        <p className="mt-2 max-w-2xl text-zinc-700 dark:text-zinc-300">
          Cliente e equipe veem a mesma situação de cada horário marcado.
        </p>
        <ol className="mt-8 grid gap-4 sm:grid-cols-4">
          {JOURNEY.map((status, index) => (
            <li key={status} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <span className="block font-medium text-rose-700 text-sm dark:text-rose-300">
                Etapa {index + 1}
              </span>
              <span className="mt-1 block font-semibold">{appointmentStatusLabel(status)}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
