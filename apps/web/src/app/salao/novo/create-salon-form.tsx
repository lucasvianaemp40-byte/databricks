'use client';

import { useActionState } from 'react';
import { Field, FormMessage, SelectField, SubmitButton } from '../../../components/form';
import type { FormState } from '../../../lib/form-state';
import { BRAZIL_TIME_ZONES } from '../../../lib/time-zones';
import { type CreateSalonField, createSalonAction } from './actions';

const INITIAL: FormState<CreateSalonField> = {};
const TIME_ZONE_OPTIONS = BRAZIL_TIME_ZONES.map((zone) => ({ value: zone.id, label: zone.label }));

export function CreateSalonForm({ origin }: { readonly origin: string }) {
  const [state, action] = useActionState(createSalonAction, INITIAL);
  return (
    <form action={action} noValidate className="mt-8 space-y-5">
      <FormMessage message={state.message} />
      <Field
        name="salonName"
        label="Nome do salão"
        autoComplete="organization"
        maxLength={120}
        defaultValue={state.values?.salonName}
        error={state.fieldErrors?.salonName}
      />
      <Field
        name="slug"
        label="Endereço da página de agendamento"
        autoComplete="off"
        maxLength={63}
        prefix={`${origin.replace(/^https?:\/\//, '')}/`}
        hint="Letras minúsculas, números e hífens. É o link que seus clientes vão usar para marcar horário."
        defaultValue={state.values?.slug}
        error={state.fieldErrors?.slug}
      />
      <Field
        name="locationName"
        label="Nome da primeira unidade"
        autoComplete="off"
        maxLength={120}
        hint="Por exemplo: Centro, Shopping ou o nome do bairro."
        defaultValue={state.values?.locationName}
        error={state.fieldErrors?.locationName}
      />
      <SelectField
        name="timezone"
        label="Fuso horário da unidade"
        options={TIME_ZONE_OPTIONS}
        defaultValue={state.values?.timezone ?? 'America/Sao_Paulo'}
        error={state.fieldErrors?.timezone}
      />
      <SubmitButton pendingLabel="Criando o salão…">Criar salão</SubmitButton>
    </form>
  );
}
