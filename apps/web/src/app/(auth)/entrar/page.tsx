import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { textLinkClasses } from '../../../components/form-field';
import { currentUser } from '../../../server/auth/session';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Entrar' };

export default async function SignInPage() {
  if ((await currentUser()) !== null) {
    redirect('/app');
  }
  return (
    <>
      <h1 className="font-bold text-3xl text-zinc-900 tracking-tight dark:text-zinc-50">
        Entrar na sua conta
      </h1>
      <p className="mt-2 text-zinc-700 dark:text-zinc-300">
        Acesse a agenda e as configurações do seu salão.
      </p>
      <div className="mt-8">
        <SignInForm />
      </div>
      <p className="mt-8 text-sm text-zinc-700 dark:text-zinc-300">
        Ainda não tem conta?{' '}
        <Link href="/cadastro" className={textLinkClasses}>
          Criar conta grátis
        </Link>
      </p>
    </>
  );
}
