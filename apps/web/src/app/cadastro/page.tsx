import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/auth/dal';
import { SignUpForm } from './sign-up-form';

export const metadata: Metadata = { title: 'Criar conta' };

export default async function SignUpPage() {
  if ((await getCurrentUser()) !== null) {
    redirect('/painel');
  }
  return (
    <section aria-labelledby="titulo-cadastro" className="mx-auto max-w-md px-4 py-12 sm:px-6">
      <h1 id="titulo-cadastro" className="font-bold text-3xl tracking-tight">
        Criar conta
      </h1>
      <p className="mt-2 text-zinc-700 dark:text-zinc-300">
        Crie sua conta de dono do salão. Depois você cadastra o salão e a primeira unidade.
      </p>
      <SignUpForm />
    </section>
  );
}
