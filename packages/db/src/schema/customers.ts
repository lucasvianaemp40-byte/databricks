import { sql } from 'drizzle-orm';
import { check, foreignKey, index, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  appSchema,
  E164_PATTERN,
  idColumn,
  instant,
  matchesPattern,
  tenantIdColumn,
  timestamps,
} from './columns';
import { tenants } from './tenants';

/**
 * Cliente final do salão (o salão é o controlador; nós somos operadores, LGPD art. 5º).
 *
 * Minimização: só nome, telefone E.164 (canal de lembrete) e e-mail opcional. Sem CPF, data
 * de nascimento, observações livres ou qualquer dado sensível nesta iteração.
 * Consentimentos mínimos como instantes (NULL = não consentiu); `privacy_notice_version`
 * registra qual aviso de privacidade foi apresentado.
 * Eliminação (art. 18): `anonymized_at` preenchido exige os campos de contato apagados.
 * Telefone é único POR TENANT (o mesmo número existe em vários salões; unicidade global
 * vazaria a existência do cliente entre tenants).
 */
export const customers = appSchema.table(
  'customers',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    fullName: text('full_name').notNull(),
    phoneE164: text('phone_e164'),
    email: text('email'),
    /** Opt-in para mensagens transacionais por WhatsApp (exigência da Meta). */
    whatsappOptInAt: instant('whatsapp_opt_in_at'),
    /** Consentimento específico para marketing (separado do transacional). */
    marketingConsentAt: instant('marketing_consent_at'),
    privacyNoticeVersion: text('privacy_notice_version'),
    anonymizedAt: instant('anonymized_at'),
    ...timestamps(),
  },
  (t) => [
    unique('customers_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('customers_tenant_phone_key')
      .on(t.tenantId, t.phoneE164)
      .where(sql`${t.phoneE164} IS NOT NULL`),
    index('customers_tenant_name_idx').on(t.tenantId, sql`lower(${t.fullName})`),
    foreignKey({
      name: 'customers_tenant_fk',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }),
    check('customers_full_name_length', sql`char_length(${t.fullName}) BETWEEN 1 AND 120`),
    check('customers_phone_e164', matchesPattern(t.phoneE164, E164_PATTERN)),
    check(
      'customers_email_format',
      sql`${t.email} = lower(${t.email}) AND char_length(${t.email}) <= 254 AND ${matchesPattern(t.email, '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$')}`,
    ),
    check(
      'customers_privacy_notice_version_length',
      sql`char_length(${t.privacyNoticeVersion}) BETWEEN 1 AND 32`,
    ),
    check(
      'customers_anonymized_without_contact',
      sql`${t.anonymizedAt} IS NULL OR (${t.phoneE164} IS NULL AND ${t.email} IS NULL AND ${t.whatsappOptInAt} IS NULL AND ${t.marketingConsentAt} IS NULL)`,
    ),
  ],
);
