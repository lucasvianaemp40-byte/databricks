import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { verificationEmail } = await import('./verification-email');

const URL_ =
  // biome-ignore lint/security/noSecrets: link de teste, não é segredo.
  'http://127.0.0.1:3100/api/auth/verify-email?token=abc&callbackURL=%2Fcadastro%2Fconfirmado';

describe('e-mail de confirmação', () => {
  it('traz o link no texto e no HTML, com assunto fixo (o nome não vai no assunto)', () => {
    const message = verificationEmail({ name: 'Ana', url: URL_ });
    expect(message.subject).toBe('Confirme seu e-mail no Agenda Salão');
    expect(message.text).toContain(URL_);
    expect(message.html).toContain(
      // biome-ignore lint/security/noSecrets: link de teste, não é segredo.
      'href="http://127.0.0.1:3100/api/auth/verify-email?token=abc&amp;callbackURL=%2Fcadastro%2Fconfirmado"',
    );
    expect(message.text).toContain('Olá, Ana');
  });

  it('escapa o nome no HTML (sem injeção de marcação)', () => {
    const message = verificationEmail({ name: '<img src=x onerror=alert(1)>', url: URL_ });
    expect(message.html).not.toContain('<img');
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('recusa link fora de http(s)', () => {
    expect(() => verificationEmail({ name: 'Ana', url: 'javascript:alert(1)' })).toThrow();
  });
});
