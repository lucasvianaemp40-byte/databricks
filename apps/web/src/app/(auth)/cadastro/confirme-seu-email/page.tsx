import type { Metadata } from 'next';
import Link from 'next/link';
import { secondaryButtonClasses } from '../../../../components/form-field';

export const metadata: Metadata = { title: 'Confirme seu e-mail' };

export default function CheckEmailPage() {
  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div
        aria-hidden="true"
        className="flex size-14 items-center justify-center rounded-2xl bg-rose-50 text-3xl dark:bg-rose-950/60"
      >
        ✉️
      </div>
      <h1 className="mt-6 font-bold text-2xl text-zinc-900 tracking-tight dark:text-zinc-50">
        Confirme seu e-mail
      </h1>
      <p className="mt-3 text-zinc-700 dark:text-zinc-300">
        Se o endereço informado puder ser usado, você vai receber um e-mail com um link de
        confirmação. Abra o link para ativar a conta. Ele vale por 1 hora.
      </p>
      <ul className="mt-6 space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
        <li>• Confira também a caixa de spam ou promoções.</li>
        <li>• Não chegou? Entre com seu e-mail e senha: enviamos um novo link automaticamente.</li>
      </ul>
      <Link href="/entrar" className={`${secondaryButtonClasses} mt-8 w-full`}>
        Ir para o login
      </Link>
    </div>
  );
}
