import {
  OwnerNotEligibleError,
  type ProvisionTenantInput,
  SlugUnavailableError,
  TenantAlreadyProvisionedError,
} from '@salon/db';
import { formFields } from '../../lib/form-data';
import { slugify } from '../../lib/salon/slug';
import { type CreateSalonInput, createSalonSchema } from '../../lib/validation/salon';

/**
 * Núcleo da action "Criar salão" (E1.3 + E2.1), sem dependência do Next para ser testado.
 * A action (`app/app/criar-salao/actions.ts`) relê a sessão, chama esta função e redireciona.
 */

type CreateSalonField = keyof CreateSalonInput;

export interface CreateSalonState {
  readonly message?: string;
  readonly fieldErrors?: Partial<Record<CreateSalonField, string>>;
  /** Valores enviados, para o formulário não perder o que a pessoa digitou. */
  readonly values?: Partial<Record<CreateSalonField, string>>;
}

export type CreateSalonOutcome =
  | { readonly kind: 'created' }
  | { readonly kind: 'already-has-salon' }
  | { readonly kind: 'not-eligible' }
  | { readonly kind: 'invalid'; readonly state: CreateSalonState };

const FIELDS: readonly CreateSalonField[] = ['salonName', 'salonSlug', 'locationName', 'timezone'];
const GENERIC_ERROR = 'Não foi possível criar o salão agora. Tente de novo em instantes.';

function echo(fields: Record<string, string> | null): Partial<Record<CreateSalonField, string>> {
  if (fields === null) {
    return {};
  }
  return Object.fromEntries(
    FIELDS.filter((field) => typeof fields[field] === 'string').map((field) => [
      field,
      fields[field]?.slice(0, 200),
    ]),
  );
}

/** Slug da primeira unidade: derivado do nome (o banco exige ao menos 1 caractere). */
export function locationSlug(name: string): string {
  return slugify(name) || 'unidade';
}

/** Só o código e o SQLSTATE: a mensagem do banco carrega os parâmetros (dado pessoal). */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'erro desconhecido';
  }
  const { code, sqlState } = error as { code?: unknown; sqlState?: unknown };
  return [
    error.name,
    typeof code === 'string' ? code : undefined,
    typeof sqlState === 'string' ? sqlState : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

export async function createSalonFromForm(input: {
  readonly ownerUserId: string;
  readonly formData: FormData;
  readonly provision: (input: ProvisionTenantInput) => Promise<unknown>;
  readonly logFailure: (description: string) => void;
}): Promise<CreateSalonOutcome> {
  const fields = formFields(input.formData);
  const parsed = createSalonSchema.safeParse(fields);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<CreateSalonField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === 'string' && (FIELDS as readonly string[]).includes(field)) {
        fieldErrors[field as CreateSalonField] ??= issue.message;
      }
    }
    return {
      kind: 'invalid',
      state: { message: 'Revise os campos destacados.', fieldErrors, values: echo(fields) },
    };
  }

  const data = parsed.data;
  try {
    await input.provision({
      ownerUserId: input.ownerUserId,
      tenant: { name: data.salonName, slug: data.salonSlug },
      location: {
        name: data.locationName,
        slug: locationSlug(data.locationName),
        timezone: data.timezone,
      },
    });
  } catch (error) {
    if (error instanceof SlugUnavailableError) {
      return {
        kind: 'invalid',
        state: {
          message: 'Revise os campos destacados.',
          fieldErrors: { salonSlug: 'Este endereço já está em uso. Escolha outro.' },
          values: echo(fields),
        },
      };
    }
    if (error instanceof TenantAlreadyProvisionedError) {
      return { kind: 'already-has-salon' };
    }
    if (error instanceof OwnerNotEligibleError) {
      return { kind: 'not-eligible' };
    }
    input.logFailure(describeFailure(error));
    return { kind: 'invalid', state: { message: GENERIC_ERROR, values: echo(fields) } };
  }
  return { kind: 'created' };
}
