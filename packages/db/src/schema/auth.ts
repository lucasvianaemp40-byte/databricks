import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { instant, sqlStringList } from './columns';
import { tenants } from './tenants';

/**
 * Dados de autenticação do Better Auth (ADR-0004), no schema `auth`, acessados só pelo papel
 * `app_auth` (migração 0007). As tabelas são GLOBAIS (sem `tenant_id` nem RLS): o login
 * acontece antes de existir contexto de tenant. `app_user` e `app_worker` não têm acesso a
 * este schema; a resolução sessão -> membership -> tenant roda no servidor com a conexão do
 * `app_auth`.
 *
 * As chaves das propriedades são os nomes de campo do Better Auth (`emailVerified`,
 * `userId`...), que o adaptador do Drizzle usa; as colunas ficam em snake_case. Os ids são
 * gerados pelo banco (UUIDv4 aleatório; o Better Auth não os envia), exceto o da organização,
 * que é o id do tenant (UUIDv7, `provisionTenant`), sem default.
 */
export const authSchema = pgSchema('auth');

/**
 * Ids das tabelas do Better Auth: com `generateId: 'uuid'` no PostgreSQL, o Better Auth 1.7
 * NÃO envia o id e deixa o banco gerar (`gen_random_uuid()`, UUIDv4 aleatório).
 */
const authId = () => uuid('id').primaryKey().defaultRandom();

/** Papéis da organização (= tenant) no Better Auth, refinados no ADR-0004. */
export const memberRoles = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof memberRoles)[number];

/** Pessoa que faz login (dono, gerente, recepção, profissional). */
export const authUsers = authSchema.table(
  'users',
  {
    id: authId(),
    name: text('name').notNull(),
    /** Sempre em minúsculas (o Better Auth normaliza; o CHECK garante). */
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('users_email_key').on(t.email),
    check('users_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 120`),
    check('users_email_length', sql`char_length(${t.email}) BETWEEN 3 AND 254`),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_image_length', sql`char_length(${t.image}) <= 2048`),
  ],
);

/**
 * Sessão (o cookie `__Host-` guarda o token assinado). `ip_address` e `user_agent` servem à
 * segurança da conta (lista de sessões, alerta de acesso): dado pessoal, ver
 * docs/lgpd/inventario-de-dados.md.
 */
export const authSessions = authSchema.table(
  'sessions',
  {
    id: authId(),
    expiresAt: instant('expires_at').notNull(),
    token: text('token').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id').notNull(),
  },
  (t) => [
    unique('sessions_token_key').on(t.token),
    index('sessions_user_id_idx').on(t.userId),
    foreignKey({
      name: 'sessions_user_fk',
      columns: [t.userId],
      foreignColumns: [authUsers.id],
    }).onDelete('cascade'),
    check('sessions_user_agent_length', sql`char_length(${t.userAgent}) <= 1024`),
    check('sessions_ip_address_length', sql`char_length(${t.ipAddress}) <= 64`),
  ],
);

/** Credencial: `providerId = 'credential'` guarda o hash da senha (scrypt do Better Auth). */
export const authAccounts = authSchema.table(
  'accounts',
  {
    id: authId(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: instant('access_token_expires_at'),
    refreshTokenExpiresAt: instant('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('accounts_provider_account_key').on(t.providerId, t.accountId),
    index('accounts_user_id_idx').on(t.userId),
    foreignKey({
      name: 'accounts_user_fk',
      columns: [t.userId],
      foreignColumns: [authUsers.id],
    }).onDelete('cascade'),
  ],
);

/** Valores de verificação de uso único (o identificador é gravado com hash). */
export const authVerifications = authSchema.table(
  'verifications',
  {
    id: authId(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: instant('expires_at').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

/** Contadores do rate limit do Better Auth (`rateLimit.storage = 'database'`). */
export const authRateLimits = authSchema.table(
  'rate_limits',
  {
    id: authId(),
    /** `<ip>|<caminho>`, montado pelo Better Auth. */
    key: text('key').notNull(),
    count: integer('count').notNull(),
    /** Epoch em milissegundos da última requisição contada. */
    lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
  },
  (t) => [unique('rate_limits_key_key').on(t.key)],
);

/**
 * Organização do Better Auth = salão. O `id` É o `app.tenants.id` (FK): não existe
 * organização sem tenant, e o slug é o mesmo. Hoje só `provisionTenant` grava aqui; o plugin
 * `organization` do Better Auth (convites, E1.4) ainda não está ligado.
 */
export const authOrganizations = authSchema.table(
  'organizations',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    logo: text('logo'),
    createdAt: instant('created_at').notNull().defaultNow(),
    metadata: text('metadata'),
  },
  (t) => [
    unique('organizations_slug_key').on(t.slug),
    foreignKey({
      name: 'organizations_tenant_fk',
      columns: [t.id],
      foreignColumns: [tenants.id],
    }),
    check('organizations_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 120`),
  ],
);

/** Vínculo pessoa x salão com o papel. Um vínculo por pessoa e salão. */
export const authMembers = authSchema.table(
  'members',
  {
    id: authId(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role', { enum: memberRoles }).notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('members_organization_user_key').on(t.organizationId, t.userId),
    index('members_user_id_idx').on(t.userId),
    foreignKey({
      name: 'members_organization_fk',
      columns: [t.organizationId],
      foreignColumns: [authOrganizations.id],
    }),
    foreignKey({
      name: 'members_user_fk',
      columns: [t.userId],
      foreignColumns: [authUsers.id],
    }),
    check('members_role_valid', sql`${t.role} IN (${sqlStringList(memberRoles)})`),
  ],
);
