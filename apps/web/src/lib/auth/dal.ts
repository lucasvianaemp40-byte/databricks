/**
 * DAL de autenticação: a ÚNICA forma de as páginas e actions saberem quem está logado e em
 * qual salão. O tenant vem só da sessão, e o vínculo usuário × salão é conferido no banco a
 * cada requisição (`getActiveMember`), nunca confiando só no cookie (threat model A5).
 */
import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getAuth } from './server';

export interface SessionUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface TenantContext {
  readonly user: SessionUser;
  /** Id da organização do Better Auth = `app.tenants.id`. */
  readonly tenantId: string;
  readonly role: string;
}

/** Sessão da requisição atual (uma consulta por requisição), ou `null`. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) {
    return null;
  }
  return { id: session.user.id, name: session.user.name, email: session.user.email };
});

/** Exige sessão; sem ela, vai para o login. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (user === null) {
    redirect('/entrar');
  }
  return user;
}

/** Membro do salão ativo da sessão, conferido no banco; `null` se não houver. */
export const getActiveMembership = cache(async () => {
  try {
    const member = await getAuth().api.getActiveMember({ headers: await headers() });
    return { tenantId: member.organizationId, role: member.role };
  } catch {
    // Sem organização ativa, ou o usuário não é membro dela: o Better Auth lança.
    return null;
  }
});

/**
 * Exige sessão E vínculo com o salão ativo. Sem sessão vai para o login; sem salão, para a
 * criação do salão. Toda leitura/escrita de dado do salão usa o `tenantId` devolvido aqui.
 */
export async function requireTenant(): Promise<TenantContext> {
  const user = await requireUser();
  const membership = await getActiveMembership();
  if (membership === null) {
    redirect('/salao/novo');
  }
  return { user, tenantId: membership.tenantId, role: membership.role };
}
