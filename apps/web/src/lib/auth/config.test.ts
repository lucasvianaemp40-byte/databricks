import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAuthTables } from 'better-auth/db';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthNotAllowedInProductionError,
  assertAuthAllowed,
  buildAuthOptions,
  SESSION_COOKIE_PREFIX,
} from './config';

function options() {
  // Pool sem conexão: o Better Auth só conecta ao executar uma consulta.
  return buildAuthOptions({
    baseURL: 'https://agenda.exemplo.com.br',
    secret: 'x'.repeat(32),
    database: new pg.Pool({ max: 1 }),
  });
}

describe('trava de produção (ADR-0004, threat model A1)', () => {
  it('recusa APP_ENV=production enquanto não houver MFA, verificação de e-mail e HIBP', () => {
    expect(() => assertAuthAllowed('production')).toThrow(AuthNotAllowedInProductionError);
  });

  it.each(['development', 'test', 'e2e', 'preview'])('libera %s', (appEnv) => {
    expect(() => assertAuthAllowed(appEnv)).not.toThrow();
  });
});

describe('configuração do Better Auth', () => {
  it('senha de 12 a 128 caracteres, só e-mail e senha', () => {
    expect(options().emailAndPassword).toMatchObject({
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    });
  });

  it('cookie __Host- com Secure, HttpOnly, SameSite=Lax e Path=/ (ASVS 3.3), sem cache de sessão', () => {
    const { advanced, session } = options();
    expect(SESSION_COOKIE_PREFIX.startsWith('__Host-')).toBe(true);
    expect(advanced.cookiePrefix).toBe(SESSION_COOKIE_PREFIX);
    // Com useSecureCookies o Better Auth acrescentaria __Secure- antes do __Host-.
    expect(advanced.useSecureCookies).toBe(false);
    expect(advanced.defaultCookieAttributes).toEqual({
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(advanced).not.toHaveProperty('crossSubDomainCookies');
    // Sessão revogada não pode continuar válida por cache no cookie.
    expect(session.cookieCache).toEqual({ enabled: false });
  });

  it('nunca desliga a checagem de origem/CSRF e só confia na própria origem', () => {
    const built = options();
    expect(JSON.stringify(built)).not.toMatch(/disableCSRFCheck|disableOriginCheck/);
    expect(built.trustedOrigins).toEqual(['https://agenda.exemplo.com.br']);
  });

  it('ids uuid (organização = tenant), sem telemetria e sem guardar IP (minimização)', () => {
    const built = options();
    expect(built.advanced.database).toEqual({ generateId: 'uuid' });
    expect(built.telemetry).toEqual({ enabled: false });
    expect(built.advanced.ipAddress).toEqual({ disableIpTracking: true });
  });

  it('plugins: organization (1 salão por conta, criador owner) e nextCookies por último', () => {
    const ids = options().plugins.map((plugin) => plugin.id);
    expect(ids).toEqual(['organization', 'next-cookies']);
  });
});

/** Colunas por tabela, como criadas pela migração 0006 (schema auth). */
function migrationColumns(): Map<string, Map<string, { notNull: boolean }>> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- migração fixa do repositório.
  const sql = readFileSync(
    fileURLToPath(
      new URL('../../../../../packages/db/drizzle/0006_auth_schema.sql', import.meta.url),
    ),
    'utf8',
  );
  const tables = new Map<string, Map<string, { notNull: boolean }>>();
  for (const match of sql.matchAll(/CREATE TABLE auth\."(\w+)" \(\n([\s\S]*?)\n\);/g)) {
    const columns = new Map<string, { notNull: boolean }>();
    for (const line of (match[2] ?? '').split('\n')) {
      const column = /^\s*"(\w+)"\s/.exec(line);
      if (column?.[1] !== undefined) {
        columns.set(column[1], { notNull: /NOT NULL/.test(line) });
      }
    }
    tables.set(match[1] ?? '', columns);
  }
  return tables;
}

describe('drift: tabelas do Better Auth × migração 0006', () => {
  it('cada tabela e coluna que o Better Auth usa existe na migração, com a mesma obrigatoriedade', () => {
    const fromMigration = migrationColumns();
    const fromAuth = getAuthTables(options());
    expect([...fromMigration.keys()].sort()).toEqual(
      Object.values(fromAuth)
        .map((table) => table.modelName)
        .sort(),
    );
    for (const table of Object.values(fromAuth)) {
      const columns = fromMigration.get(table.modelName);
      expect(columns, table.modelName).toBeDefined();
      expect(columns?.get('id'), `${table.modelName}.id`).toEqual({ notNull: true });
      for (const [field, definition] of Object.entries(table.fields)) {
        const name = definition.fieldName ?? field;
        expect(columns?.get(name), `${table.modelName}.${name}`).toEqual({
          notNull: definition.required !== false,
        });
      }
      // Nada a mais na migração além do que o Better Auth conhece.
      expect(columns?.size, table.modelName).toBe(Object.keys(table.fields).length + 1);
    }
  });
});

describe('sessão nova já aponta para o salão do usuário', () => {
  const session = {
    id: 's1',
    userId: 'u1',
    token: 't',
    expiresAt: new Date('2027-01-01T00:00:00Z'),
    createdAt: new Date('2026-12-25T00:00:00Z'),
    updatedAt: new Date('2026-12-25T00:00:00Z'),
  };

  function contextWithMember(member: { organizationId: string } | null) {
    const findOne = vi.fn(() => Promise.resolve(member));
    return { findOne, context: { context: { adapter: { findOne } } } };
  }

  it('login de quem já tem salão: a sessão nasce com a organização ativa (evita cair na criação)', async () => {
    const onSessionCreate = options().databaseHooks.session.create.before;
    const { findOne, context } = contextWithMember({ organizationId: 'org-1' });
    await expect(onSessionCreate(session, context as never)).resolves.toEqual({
      data: { ...session, activeOrganizationId: 'org-1' },
    });
    expect(findOne).toHaveBeenCalledWith({
      model: 'member',
      where: [{ field: 'userId', value: 'u1' }],
    });
  });

  it('quem ainda não tem salão (ou sem contexto): a sessão nasce sem organização ativa', async () => {
    const onSessionCreate = options().databaseHooks.session.create.before;
    await expect(
      onSessionCreate(session, contextWithMember(null).context as never),
    ).resolves.toBeUndefined();
    await expect(onSessionCreate(session, null)).resolves.toBeUndefined();
  });
});
