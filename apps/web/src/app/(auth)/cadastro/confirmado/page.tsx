import type { Metadata } from 'next';
import Link from 'next/link';
import { primaryButtonClasses } from '../../../../components/form-field';

export const metadata: Metadata = { title: 'E-mail confirmado' };

/**
 * Destino do link de confirmação. Sem login automático (LC-06): a pessoa entra com a própria
 * senha. Com `?error=`, o link era inválido ou expirou.
 */
export default async function ConfirmedPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const { error } = await searchParams;
  const failed = error !== undefined;
  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div
        aria-hidden="true"
        className={`flex size-14 items-center justify-center rounded-2xl text-3xl ${failed ? 'bg-amber-50 dark:bg-amber-950/50' : 'bg-emerald-50 dark:bg-emerald-950/50'}`}
      >
        {failed ? '⏳' : '✅'}
      </div>
      <h1 className="mt-6 font-bold text-2xl text-zinc-900 tracking-tight dark:text-zinc-50">
        {failed ? 'Link inválido ou expirado' : 'E-mail confirmado'}
      </h1>
      <p className="mt-3 text-zinc-700 dark:text-zinc-300">
        {failed
          ? 'Entre com seu e-mail e senha: se a conta ainda não estiver confirmada, enviamos um novo link.'
          : 'Sua conta está ativa. Entre com seu e-mail e senha para cadastrar o salão.'}
      </p>
      <Link href="/entrar" className={`${primaryButtonClasses} mt-8`}>
        Entrar
      </Link>
    </div>
  );
}
