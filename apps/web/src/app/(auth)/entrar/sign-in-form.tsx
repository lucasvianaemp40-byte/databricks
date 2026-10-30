'use client';

import { type SyntheticEvent, useState, useTransition } from 'react';
import { FormAlert, FormField, primaryButtonClasses } from '../../../components/form-field';
import { signIn } from '../../../lib/auth/client';
import { signInErrorMessage } from '../../../lib/auth/messages';
import { signInSchema } from '../../../lib/validation/account';

type Field = 'email' | 'password';

export function SignInForm() {
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [message, setMessage] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  function onSubmit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = signInSchema.safeParse({
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
      const result = await signIn(parsed.data);
      if (result.ok) {
        // Navegação completa: o servidor relê a sessão do cookie novo.
        window.location.assign('/app');
        return;
      }
      setMessage(signInErrorMessage(result));
    });
  }

  return (
    <form method="post" noValidate onSubmit={onSubmit} className="space-y-5" aria-label="Entrar">
      <FormAlert message={message} />
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
      />
      <FormField
        id="password"
        name="password"
        type="password"
        label="Senha"
        autoComplete="current-password"
        required
        maxLength={128}
        error={errors.password}
      />
      <button type="submit" className={primaryButtonClasses} disabled={pending}>
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
