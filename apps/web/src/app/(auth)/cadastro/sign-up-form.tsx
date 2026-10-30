'use client';

import { useRouter } from 'next/navigation';
import { type SyntheticEvent, useState, useTransition } from 'react';
import { FormAlert, FormField, primaryButtonClasses } from '../../../components/form-field';
import { signUp } from '../../../lib/auth/client';
import { signUpErrorMessage } from '../../../lib/auth/messages';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  signUpSchema,
} from '../../../lib/validation/account';

type Field = 'name' | 'email' | 'password';

export function SignUpForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [message, setMessage] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  function onSubmit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = signUpSchema.safeParse({
      name: data.get('name'),
      email: data.get('email'),
      password: data.get('password'),
    });
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        next[issue.path[0] as Field] ??= issue.message;
      }
      setErrors(next);
      setMessage(undefined);
      return;
    }
    setErrors({});
    startTransition(async () => {
      const result = await signUp(parsed.data);
      if (result.ok) {
        router.push('/cadastro/confirme-seu-email');
        return;
      }
      setMessage(signUpErrorMessage(result));
    });
  }

  return (
    <form noValidate onSubmit={onSubmit} className="space-y-5" aria-label="Criar conta">
      <FormAlert message={message} />
      <FormField
        id="name"
        name="name"
        label="Seu nome"
        autoComplete="name"
        required
        maxLength={120}
        error={errors.name}
      />
      <FormField
        id="email"
        name="email"
        type="email"
        label="E-mail"
        autoComplete="email"
        inputMode="email"
        required
        maxLength={254}
        error={errors.email}
        hint="Enviaremos um link para confirmar que o e-mail é seu."
      />
      <FormField
        id="password"
        name="password"
        type="password"
        label="Senha"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        error={errors.password}
        hint={`Pelo menos ${PASSWORD_MIN_LENGTH} caracteres. Uma frase fácil de lembrar funciona bem.`}
      />
      <button type="submit" className={primaryButtonClasses} disabled={pending}>
        {pending ? 'Criando conta…' : 'Criar conta'}
      </button>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Usamos seu nome e e-mail só para a sua conta e para avisos de segurança.
      </p>
    </form>
  );
}
