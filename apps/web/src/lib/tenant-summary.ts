/**
 * Resumo do salão para o painel e a retomada da criação. O tenant vem sempre da sessão (DAL);
 * a consulta roda por `withTenant`, com a RLS como segunda camada.
 */
import 'server-only';
import { getTenantSummary, type TenantSummary } from '@salon/db';
import { getAppDb } from './auth/server';

export function findTenantSummary(tenantId: string): Promise<TenantSummary | null> {
  return getTenantSummary(getAppDb(), tenantId);
}
