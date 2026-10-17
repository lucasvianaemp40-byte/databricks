import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Página não encontrada',
};

export default function NotFound() {
  return (
    <section
      aria-labelledby="titulo-nao-encontrada"
      className="mx-auto max-w-5xl px-4 py-24 sm:px-6"
    >
      <p className="font-medium text-rose-700 text-sm dark:text-rose-300">Erro 404</p>
      <h1 id="titulo-nao-encontrada" className="mt-3 font-bold text-3xl tracking-tight sm:text-4xl">
        Página não encontrada
      </h1>
      <p className="mt-4 max-w-xl text-zinc-700 dark:text-zinc-300">
        O endereço pode ter mudado ou ter sido digitado com algum erro.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex min-h-11 items-center rounded-md bg-rose-700 px-5 font-medium text-white hover:bg-rose-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 dark:bg-rose-300 dark:text-zinc-950 dark:hover:bg-rose-200 dark:focus-visible:outline-rose-300"
      >
        Voltar para a página inicial
      </Link>
    </section>
  );
}
