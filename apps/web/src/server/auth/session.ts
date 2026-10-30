import 'server-only';
import { listMemberships } from '@salon/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { authDb } from '../db';
import { getAuth } from './index';
import {
  type AccessContext,
  resolveAccess,
  type SessionUser,
  toSessionUser,
} from './tenant-context';

/**
 * DAL de autenticação das páginas e actions (a autorização é aqui, nunca no Proxy). A sessão
 * é relida do banco a cada requisição (sem `cookieCache`); `cache` só deduplica dentro da
 * mesma renderização.
 */
const readSession = cache(async () => getAuth().api.getSession({ headers: await headers() }));

const access = cache(
  (): Promise<AccessContext> =>
    resolveAccess({
      getSession: readSession,
      listMemberships: (userId) => listMemberships(authDb(), userId),
    }),
);

/** Pessoa logada e com e-mail confirmado, ou `null`. */
export async function currentUser(): Promise<SessionUser | null> {
  return toSessionUser(await readSession());
}

/** Exige sessão; sem ela, vai para o login. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (user === null) {
    redirect('/entrar');
  }
  return user;
}

/** Exige sessão E salão; sem salão, vai para a criação do salão. */
export async function requireTenant(): Promise<Extract<AccessContext, { kind: 'tenant' }>> {
  const context = await access();
  if (context.kind === 'anonymous') {
    redirect('/entrar');
  }
  if (context.kind === 'no-tenant') {
    redirect('/app/criar-salao');
  }
  return context;
}

/** Para a página de criação: quem já tem salão vai para o painel. */
export async function requireUserWithoutTenant(): Promise<SessionUser> {
  const context = await access();
  if (context.kind === 'anonymous') {
    redirect('/entrar');
  }
  if (context.kind === 'tenant') {
    redirect('/app');
  }
  return context.user;
}
