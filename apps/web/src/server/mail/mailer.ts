import 'server-only';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Envio de e-mail. Nesta iteração não há provedor: em development/test/e2e cada mensagem vira
 * um arquivo no outbox local (o E2E lê o link de confirmação dali); em preview/production o
 * envio falha fechado e o cadastro fica desligado (`server/auth/config.ts`), então nenhuma
 * conta fica presa sem confirmação. O provedor real entra com um adaptador novo desta
 * interface.
 */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface Mailer {
  /** Há transporte configurado (sem ele, o cadastro fica desligado). */
  readonly available: boolean;
  send(message: MailMessage): Promise<void>;
}

export class MailTransportUnavailableError extends Error {
  override readonly name = 'MailTransportUnavailableError';

  constructor() {
    super('Nenhum transporte de e-mail configurado neste ambiente.');
  }
}

export const unavailableMailer: Mailer = {
  available: false,
  send() {
    return Promise.reject(new MailTransportUnavailableError());
  },
};

/**
 * Outbox em arquivo (só development/test/e2e; a env recusa `MAIL_OUTBOX_DIR` fora deles).
 * Pasta 0700, arquivo 0600 criado com `wx` (nunca sobrescreve nem segue um arquivo que já
 * exista), nome aleatório sem o destinatário, e recusa de pasta que seja link simbólico.
 */
export function createOutboxMailer(directory: string): Mailer {
  return {
    available: true,
    async send(message) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- MAIL_OUTBOX_DIR validada na env (caminho absoluto, só dev/test/e2e).
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- idem.
      if ((await lstat(directory)).isSymbolicLink()) {
        throw new Error('outbox: a pasta é um link simbólico; recusado');
      }
      const file = join(directory, `${Date.now()}-${randomUUID()}.json`);
      const content = JSON.stringify({ ...message, createdAt: new Date().toISOString() });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- nome gerado aqui (timestamp + UUID).
      await writeFile(file, content, { flag: 'wx', mode: 0o600 });
    },
  };
}
