// Fixture de `semgrep --test` para pii-in-logs. Dados sintéticos; código ruim de propósito.
interface Customer {
  readonly id: string;
  readonly name: string;
  readonly phoneE164: string;
  readonly email: string;
  readonly cpf: string;
}

declare const logger: {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};
declare const ctx: { readonly logger: { warn: (...args: unknown[]) => void } };
declare const customer: Customer;
declare const customers: readonly Customer[];
declare const service: { readonly name: string };
declare const job: { readonly name: string };
declare const tenantId: string;
declare const email: string;
declare const message: string;
declare const error: Error;
// Linha crua do banco (sql`...` sem o mapeamento do Drizzle): colunas em snake_case.
declare const row: { readonly full_name: string; readonly phone_e164: string };
declare const session: { readonly user: { readonly id: string; readonly email: string } };
declare const Sentry: {
  setUser: (user: unknown) => void;
  captureMessage: (message: string) => void;
};
declare const posthog: { capture: (event: string, properties?: unknown) => void };
declare const analytics: { identify: (traits: unknown) => void };

export function examples(): void {
  // ruleid: pii-in-logs
  console.log('cliente criado', customer.name);

  // ruleid: pii-in-logs
  logger.info({ tenantId, phone: customer.phoneE164 }, 'lembrete enviado');

  // ruleid: pii-in-logs
  logger.error(`falha ao enviar e-mail para ${customer.email}`);

  // ruleid: pii-in-logs
  logger.info({ customer }, 'reserva confirmada');

  // ruleid: pii-in-logs
  console.warn('e-mail inválido', email);

  // ruleid: pii-in-logs
  logger.info({ cpf: customer.cpf });

  // ruleid: pii-in-logs
  logger.info({ contact: customer.email }, 'contato atualizado');

  // ruleid: pii-in-logs
  logger.info({ who: customer.name }, 'cliente atendido');

  // ruleid: pii-in-logs
  ctx.logger.warn('telefone inválido', customer.phoneE164);

  // ok: pii-in-logs
  logger.info({ tenantId, customerId: customer.id }, 'reserva confirmada');

  // ok: pii-in-logs
  logger.info({ name: 'booking.confirmed', tenantId }, 'evento publicado');

  // ok: pii-in-logs
  console.error('falha ao confirmar reserva', { customerId: customer.id });

  // ok: pii-in-logs
  logger.error({ errorName: error.name, tenantId }, 'falha inesperada');

  // ok: pii-in-logs
  logger.info('serviço publicado', service.name);
}

// Dado pessoal em concatenação, JSON.stringify, sob chave genérica, por colchete, em coluna
// snake_case e nos SDKs de observabilidade e analytics.
export function indirect(): void {
  // ruleid: pii-in-logs
  console.log('Cliente: ' + customer.phoneE164);

  // ruleid: pii-in-logs
  console.error('falha no envio para ' + email);

  // ruleid: pii-in-logs
  console.log(JSON.stringify(customer));

  // ruleid: pii-in-logs
  logger.info({ data: customer }, 'payload recebido');

  // ruleid: pii-in-logs
  logger.info({ ...customer, tenantId }, 'cliente atualizado');

  // ruleid: pii-in-logs
  console.log(customer['email']);

  // ruleid: pii-in-logs
  logger.info(row.full_name, tenantId);

  // ruleid: pii-in-logs
  logger.info({ phone_e164: row.phone_e164 }, 'lembrete');

  // ruleid: pii-in-logs
  ctx.logger.warn('login', session.user.email.toLowerCase());

  // ruleid: pii-in-logs
  Sentry.setUser({ id: customer.id, email: customer.email });

  // ruleid: pii-in-logs
  Sentry.captureMessage(`reserva de ${customer.name} falhou`);

  // ruleid: pii-in-logs
  posthog.capture('booking_created', { phone: customer.phoneE164 });

  // ruleid: pii-in-logs
  analytics.identify(customer);

  // ok: pii-in-logs
  logger.info({ userId: session.user.id }, 'login');

  // ok: pii-in-logs
  logger.info('clientes importados', customers.length);

  // ok: pii-in-logs
  logger.info(`[migrate] ${message}`);

  // ok: pii-in-logs
  logger.error(error.name + ': ' + error.message);

  // ok: pii-in-logs
  logger.info(`job ${job.name} concluído`);

  // ok: pii-in-logs
  logger.info(JSON.stringify({ customerId: customer.id, tenantId }));

  // ok: pii-in-logs
  Sentry.setUser({ id: customer.id });

  // ok: pii-in-logs
  posthog.capture('booking_created', { tenantId, customerId: customer.id });
}
