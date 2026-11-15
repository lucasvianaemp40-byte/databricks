import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/auth/dal';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Entrar' };

export default async function SignInPage() {
  if ((await getCurrentUser()) !== null) {
    redirect('/painel');
  }
  return (
    <section aria-labelledby="titulo-entrar" className="mx-auto max-w-md px-4 py-12 sm:px-6">
      <h1 id="titulo-entrar" className="font-bold text-3xl tracking-tight">
        Entrar
      </h1>
      <p className="mt-2 text-zinc-700 dark:text-zinc-300">Acesse o painel do seu salão.</p>
      <SignInForm />
    </section>
  );
}
