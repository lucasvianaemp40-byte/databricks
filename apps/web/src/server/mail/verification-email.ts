import 'server-only';
import type { MailMessage } from './mailer';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * E-mail de confirmação do cadastro. O nome já chega validado (sem controle nem bidi) e é
 * escapado no HTML; assunto fixo (o nome nunca vai para cabeçalho). O link vem do Better
 * Auth, montado sobre `APP_URL` (nunca sobre o Host da requisição).
 */
export function verificationEmail(input: {
  readonly name: string;
  readonly url: string;
}): Omit<MailMessage, 'to'> {
  const url = new URL(input.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('verificationEmail: o link precisa ser http(s)');
  }
  const href = escapeHtml(url.href);
  const name = escapeHtml(input.name);
  return {
    subject: 'Confirme seu e-mail no Agenda Salão',
    text: [
      `Olá, ${input.name}!`,
      '',
      'Para ativar sua conta no Agenda Salão, confirme seu e-mail abrindo o link abaixo:',
      url.href,
      '',
      'O link vale por 1 hora. Se você não criou esta conta, ignore este e-mail.',
    ].join('\n'),
    html: [
      `<p>Olá, ${name}!</p>`,
      '<p>Para ativar sua conta no Agenda Salão, confirme seu e-mail:</p>',
      `<p><a href="${href}">Confirmar meu e-mail</a></p>`,
      '<p>O link vale por 1 hora. Se você não criou esta conta, ignore este e-mail.</p>',
    ].join('\n'),
  };
}
