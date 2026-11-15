'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Field, FormMessage, SubmitButton } from '../../components/form';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../lib/auth/validation';
import type { FormState } from '../../lib/form-state';
import { type SignUpField, signUpAction } from './actions';

const INITIAL: FormState<SignUpField> = {};

export function SignUpForm() {
  const [state, action] = useActionState(signUpAction, INITIAL);
  return (
    <form action={action} noValidate className="mt-8 space-y-5">
      <FormMessage message={state.message} />
      <Field
        name="name"
        label="Seu nome"
        autoComplete="name"
        maxLength={120}
        defaultValue={state.values?.name}
        error={state.fieldErrors?.name}
      />
      <Field
        name="email"
        label="E-mail"
        type="email"
        autoComplete="email"
        maxLength={254}
        defaultValue={state.values?.email}
        error={state.fieldErrors?.email}
      />
      <Field
        name="password"
        label="Senha"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        hint={`De ${PASSWORD_MIN_LENGTH} a ${PASSWORD_MAX_LENGTH} caracteres. Uma frase fácil de lembrar funciona bem.`}
        error={state.fieldErrors?.password}
      />
      <SubmitButton pendingLabel="Criando a conta…">Criar conta</SubmitButton>
      <p className="text-center text-sm text-zinc-700 dark:text-zinc-300">
        Já tem conta?{' '}
        <Link href="/entrar" className="font-medium text-rose-700 underline dark:text-rose-300">
          Entrar
        </Link>
      </p>
    </form>
  );
}
