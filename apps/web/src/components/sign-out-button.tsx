'use client';

import { useState, useTransition } from 'react';
import { signOut } from '../lib/auth/client';
import { secondaryButtonClasses } from './form-field';

export function SignOutButton() {
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex items-center gap-3">
      {failed ? (
        <span role="alert" className="text-red-700 text-sm dark:text-red-400">
          Não foi possível sair. Tente de novo.
        </span>
      ) : null}
      <button
        type="button"
        className={secondaryButtonClasses}
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            const result = await signOut();
            if (result.ok) {
              window.location.assign('/entrar');
              return;
            }
            setFailed(true);
          });
        }}
      >
        {pending ? 'Saindo…' : 'Sair'}
      </button>
    </div>
  );
}
