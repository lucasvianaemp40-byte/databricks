'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Field, FormMessage, SubmitButton } from '../../components/form';
import type { FormState } from '../../lib/form-state';
import { type SignInField, signInAction } from './actions';

const INITIAL: FormState<SignInField> = {};

export function SignInForm() {
  const [state, action] = useActionState(signInAction, INITIAL);
  return (
    <form action={action} noValidate className="mt-8 space-y-5">
      <FormMessage message={state.message} />
      <Field
        name="email"
        label="E-mail"
        type="email"
        autoComplete="email"
        maxLength={254}
        defaultValue={state.values?.email}
      />
      <Field
        name="password"
        label="Senha"
        type="password"
        autoComplete="current-password"
        maxLength={128}
      />
      <SubmitButton pendingLabel="Entrando…">Entrar</SubmitButton>
      <p className="text-center text-sm text-zinc-700 dark:text-zinc-300">
        Ainda não tem conta?{' '}
        <Link href="/cadastro" className="font-medium text-rose-700 underline dark:text-rose-300">
          Criar conta
        </Link>
      </p>
    </form>
  );
}
