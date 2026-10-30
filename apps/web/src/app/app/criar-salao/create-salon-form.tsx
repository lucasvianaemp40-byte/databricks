'use client';

import { useActionState, useState } from 'react';
import {
  FormAlert,
  FormField,
  inputClasses,
  primaryButtonClasses,
} from '../../../components/form-field';
import type { TimeZoneOption } from '../../../lib/salon/brazil-timezones';
import { slugify } from '../../../lib/salon/slug';
import { createSalonAction } from './actions';

const fieldsetClasses =
  'space-y-5 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-900';
const legendClasses =
  'float-left mb-1 w-full font-semibold text-lg text-zinc-900 dark:text-zinc-50';

export function CreateSalonForm({
  timeZones,
  defaultTimeZone,
}: Readonly<{ timeZones: readonly TimeZoneOption[]; defaultTimeZone: string }>) {
  const [state, formAction, pending] = useActionState(createSalonAction, {});
  const [salonName, setSalonName] = useState('');
  const [salonSlug, setSalonSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [locationName, setLocationName] = useState('');
  const [timezone, setTimezone] = useState(defaultTimeZone);
  const errors = state.fieldErrors ?? {};
  const timezoneError = errors.timezone;

  return (
    <form action={formAction} noValidate className="space-y-6" aria-label="Cadastrar salão">
      <FormAlert message={state.message} />

      <fieldset className={fieldsetClasses}>
        <legend className={legendClasses}>1. Seu salão</legend>
        <FormField
          id="salonName"
          name="salonName"
          label="Nome do salão"
          placeholder="Ex.: Salão Bela Vista"
          autoComplete="organization"
          required
          maxLength={120}
          value={salonName}
          onChange={(event) => {
            setSalonName(event.target.value);
            if (!slugEdited) {
              setSalonSlug(slugify(event.target.value));
            }
          }}
          error={errors.salonName}
        />
        <FormField
          id="salonSlug"
          name="salonSlug"
          label="Endereço da página de agendamento"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={63}
          value={salonSlug}
          onChange={(event) => {
            setSlugEdited(true);
            setSalonSlug(event.target.value.toLowerCase());
          }}
          error={errors.salonSlug}
          hint={
            <>
              Seus clientes vão agendar em{' '}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                agendasalao.com.br/{salonSlug || 'seu-salao'}
              </span>
              . O nome e o endereço do salão ficam públicos.
            </>
          }
        />
      </fieldset>

      <fieldset className={fieldsetClasses}>
        <legend className={legendClasses}>2. Primeira unidade</legend>
        <FormField
          id="locationName"
          name="locationName"
          label="Nome da unidade"
          placeholder="Ex.: Unidade Centro"
          required
          maxLength={120}
          value={locationName}
          onChange={(event) => setLocationName(event.target.value)}
          error={errors.locationName}
        />
        <div>
          <label
            htmlFor="timezone"
            className="block font-medium text-sm text-zinc-800 dark:text-zinc-200"
          >
            Fuso horário da unidade
          </label>
          <select
            id="timezone"
            name="timezone"
            required
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            aria-invalid={timezoneError === undefined ? undefined : true}
            aria-describedby={
              timezoneError === undefined ? 'timezone-dica' : 'timezone-erro timezone-dica'
            }
            className={inputClasses}
          >
            {timeZones.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {timezoneError === undefined ? null : (
            <p id="timezone-erro" className="mt-1.5 text-red-700 text-sm dark:text-red-400">
              {timezoneError}
            </p>
          )}
          <p id="timezone-dica" className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            Os horários da agenda sempre aparecem no fuso da unidade, mesmo para quem agenda de
            outro estado.
          </p>
        </div>
      </fieldset>

      <button type="submit" className={primaryButtonClasses} disabled={pending}>
        {pending ? 'Criando salão…' : 'Criar salão'}
      </button>
    </form>
  );
}
