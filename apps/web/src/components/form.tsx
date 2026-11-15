'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

interface FieldProps {
  readonly name: string;
  readonly label: string;
  readonly type?: 'text' | 'email' | 'password';
  readonly autoComplete: string;
  readonly defaultValue?: string | undefined;
  readonly error?: string | undefined;
  readonly hint?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly prefix?: string;
}

const inputClass =
  'mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-base text-zinc-900 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 aria-[invalid=true]:border-red-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

/** Campo com rótulo, dica e erro ligados por aria-describedby (WCAG 1.3.1 e 3.3.1). */
export function Field(props: FieldProps) {
  const { name, label, type = 'text', autoComplete, defaultValue, error, hint, prefix } = props;
  const hintId = hint === undefined ? undefined : `${name}-dica`;
  const errorId = error === undefined ? undefined : `${name}-erro`;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const input = (
    <input
      id={name}
      name={name}
      type={type}
      autoComplete={autoComplete}
      defaultValue={defaultValue}
      required
      minLength={props.minLength}
      maxLength={props.maxLength}
      aria-invalid={error === undefined ? undefined : true}
      aria-describedby={describedBy}
      className={inputClass}
    />
  );
  return (
    <div>
      <label htmlFor={name} className="block font-medium text-sm">
        {label}
      </label>
      {prefix === undefined ? (
        input
      ) : (
        <div className="flex items-center gap-1">
          <span className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{prefix}</span>
          {input}
        </div>
      )}
      {hint === undefined ? null : (
        <p id={hintId} className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="mt-1 font-medium text-red-700 text-sm dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

interface SelectFieldProps {
  readonly name: string;
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly defaultValue?: string | undefined;
  readonly error?: string | undefined;
}

export function SelectField({ name, label, options, defaultValue, error }: SelectFieldProps) {
  const errorId = error === undefined ? undefined : `${name}-erro`;
  return (
    <div>
      <label htmlFor={name} className="block font-medium text-sm">
        {label}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue}
        required
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={errorId}
        className={inputClass}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error === undefined ? null : (
        <p id={errorId} className="mt-1 font-medium text-red-700 text-sm dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/** Mensagem geral do formulário, anunciada por leitores de tela. */
export function FormMessage({ message }: { readonly message?: string | undefined }) {
  return (
    <div role="alert" aria-live="assertive">
      {message === undefined ? null : (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-800 text-sm dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {message}
        </p>
      )}
    </div>
  );
}

export function SubmitButton({
  children,
  pendingLabel,
}: {
  readonly children: ReactNode;
  readonly pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className="w-full rounded-md bg-rose-700 px-4 py-2.5 font-semibold text-white hover:bg-rose-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 disabled:opacity-70"
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
