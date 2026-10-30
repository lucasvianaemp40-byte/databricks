import type { InputHTMLAttributes, ReactNode } from 'react';

const INPUT_CLASSES =
  'mt-1.5 block w-full rounded-xl border border-zinc-300 bg-white px-3.5 py-2.5 text-base text-zinc-900 shadow-xs outline-none transition placeholder:text-zinc-400 focus:border-rose-600 focus:ring-4 focus:ring-rose-600/15 aria-invalid:border-red-600 aria-invalid:focus:ring-red-600/15 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-rose-400 dark:focus:ring-rose-400/20 dark:aria-invalid:border-red-400';

export const inputClasses = INPUT_CLASSES;

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
}

/** Campo com rótulo, dica e erro ligados por `aria-describedby` (WCAG 1.3.1 e 3.3.1). */
export function FormField({ id, label, hint, error, className, ...input }: FieldProps) {
  const hintId = hint === undefined ? undefined : `${id}-dica`;
  const errorId = error === undefined ? undefined : `${id}-erro`;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="block font-medium text-sm text-zinc-800 dark:text-zinc-200">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy}
        className={INPUT_CLASSES}
        {...input}
      />
      {error === undefined ? null : (
        <p id={errorId} className="mt-1.5 text-red-700 text-sm dark:text-red-400">
          {error}
        </p>
      )}
      {hint === undefined ? null : (
        <p id={hintId} className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Mensagem de erro do formulário inteiro, anunciada por leitores de tela. */
export function FormAlert({ message }: { readonly message: string | undefined }) {
  if (message === undefined) {
    return null;
  }
  return (
    <div
      role="alert"
      className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-800 text-sm dark:border-red-900 dark:bg-red-950/60 dark:text-red-200"
    >
      {message}
    </div>
  );
}

export const primaryButtonClasses =
  'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-rose-700 px-4 py-3 font-semibold text-base text-white shadow-sm transition hover:bg-rose-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-rose-600 dark:hover:bg-rose-500 dark:focus-visible:outline-rose-400';

export const secondaryButtonClasses =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 font-medium text-sm text-zinc-800 transition hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800';

export const textLinkClasses =
  'font-semibold text-rose-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 dark:text-rose-300';
