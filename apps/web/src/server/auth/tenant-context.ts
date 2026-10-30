import type { MemberRole, Membership } from '@salon/db';

/**
 * Resolução sessão -> vínculo -> tenant (LC-30, LC-31), separada do Next para ser testada.
 * O `tenantId` sai SÓ do vínculo da pessoa da sessão (nunca de query, corpo ou cookie). Erro
 * em qualquer consulta propaga (o Next mostra a página de erro): nunca há um tenant "padrão".
 */

export interface SessionUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface SessionLike {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly emailVerified: boolean;
  };
}

export type AccessContext =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'no-tenant'; readonly user: SessionUser }
  | {
      readonly kind: 'tenant';
      readonly user: SessionUser;
      readonly tenantId: string;
      readonly role: MemberRole;
    };

export interface AccessDependencies {
  readonly getSession: () => Promise<SessionLike | null>;
  readonly listMemberships: (userId: string) => Promise<readonly Membership[]>;
}

export function toSessionUser(session: SessionLike | null): SessionUser | null {
  if (session === null || !session.user.emailVerified) {
    return null;
  }
  return { id: session.user.id, name: session.user.name, email: session.user.email };
}

export async function resolveAccess(deps: AccessDependencies): Promise<AccessContext> {
  const user = toSessionUser(await deps.getSession());
  if (user === null) {
    return { kind: 'anonymous' };
  }
  // Uma conta, um salão nesta iteração: o vínculo mais antigo.
  const [membership] = await deps.listMemberships(user.id);
  if (membership === undefined) {
    return { kind: 'no-tenant', user };
  }
  return { kind: 'tenant', user, tenantId: membership.tenantId, role: membership.role };
}
