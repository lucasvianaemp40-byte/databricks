import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { textLinkClasses } from '../../../components/form-field';
import { currentUser } from '../../../server/auth/session';
import { SignUpForm } from './sign-up-form';

export const metadata: Metadata = { title: 'Criar conta' };

export default async function SignUpPage() {
  if ((await currentUser()) !== null) {
    redirect('/app');
  }
  return (
    <>
      <p className="font-semibold text-rose-700 text-sm dark:text-rose-300">Etapa 1 de 2</p>
      <h1 className="mt-2 font-bold text-3xl text-zinc-900 tracking-tight dark:text-zinc-50">
        Crie a conta do seu salão
      </h1>
      <p className="mt-2 text-zinc-700 dark:text-zinc-300">
        Leva menos de um minuto. Depois você cadastra o salão e a primeira unidade.
      </p>
      <div className="mt-8">
        <SignUpForm />
      </div>
      <p className="mt-8 text-sm text-zinc-700 dark:text-zinc-300">
        Já tem conta?{' '}
        <Link href="/entrar" className={textLinkClasses}>
          Entrar
        </Link>
      </p>
    </>
  );
}
