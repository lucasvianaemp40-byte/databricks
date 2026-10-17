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
declare const service: { readonly name: string };
declare const tenantId: string;
declare const email: string;
declare const error: Error;

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
