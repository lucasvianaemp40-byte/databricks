import { SignOutButton } from './sign-out-button';

/** Barra da área logada: de quem é a conta e o botão de sair. */
export function AppTopBar({ heading, userName }: Readonly<{ heading: string; userName: string }>) {
  return (
    <div className="border-zinc-200 border-b bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <p className="font-semibold text-zinc-900 dark:text-zinc-100">{heading}</p>
        <div className="flex items-center gap-4">
          <p className="hidden text-sm text-zinc-700 sm:block dark:text-zinc-300">{userName}</p>
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}
