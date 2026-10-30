import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { parseServerEnv, ServerEnvError } = await import('./env');

// Valores falsos de teste, montados em tempo de execução (nenhuma credencial literal).
const user = (name: string) => `postgresql://${name}:${'x'.repeat(8)}@127.0.0.1:5432/app`;
const SECRET = 'k'.repeat(48);

const VALID = {
  APP_ENV: 'development',
  DATABASE_URL: user('app_user'),
  DATABASE_URL_AUTH: user('app_auth'),
  BETTER_AUTH_SECRET: SECRET,
  MAIL_OUTBOX_DIR: '/tmp/salon-outbox',
};

function issues(runtime: Record<string, string | undefined>): string {
  try {
    parseServerEnv(runtime);
  } catch (error) {
    expect(error).toBeInstanceOf(ServerEnvError);
    return (error as Error).message;
  }
  throw new Error('esperava erro de validação');
}

describe('parseServerEnv', () => {
  it('aceita a configuração local completa', () => {
    expect(parseServerEnv(VALID)).toEqual({
      appEnv: 'development',
      databaseUrl: VALID.DATABASE_URL,
      databaseUrlAuth: VALID.DATABASE_URL_AUTH,
      betterAuthSecret: SECRET,
      mailOutboxDir: '/tmp/salon-outbox',
    });
  });

  it('exige as duas URLs do banco e o segredo (falha fechada, sem valor padrão)', () => {
    const message = issues({ APP_ENV: 'development' });
    expect(message).toContain('DATABASE_URL:');
    expect(message).toContain('DATABASE_URL_AUTH:');
    expect(message).toContain('BETTER_AUTH_SECRET:');
  });

  it('nunca ecoa o valor recebido (pode ser segredo)', () => {
    const leaked = 'segredo-que-nao-pode-aparecer';
    const message = issues({ ...VALID, DATABASE_URL: leaked, BETTER_AUTH_SECRET: leaked });
    expect(message).not.toContain(leaked);
  });

  it('recusa URL que não é PostgreSQL e a mesma URL para os dois papéis', () => {
    expect(issues({ ...VALID, DATABASE_URL: 'mysql://x@y/z' })).toContain('DATABASE_URL:');
    expect(issues({ ...VALID, DATABASE_URL_AUTH: VALID.DATABASE_URL })).toContain(
      'DATABASE_URL_AUTH:',
    );
  });

  it('segredo de pelo menos 32 caracteres e diferente do exemplo', () => {
    expect(issues({ ...VALID, BETTER_AUTH_SECRET: 'curto' })).toContain('BETTER_AUTH_SECRET:');
    expect(
      issues({
        ...VALID,
        BETTER_AUTH_SECRET: 'troque-por-um-segredo-aleatorio-de-32-bytes-ou-mais',
      }),
    ).toContain('BETTER_AUTH_SECRET:');
  });

  it.each(['preview', 'production'])(
    'recusa MAIL_OUTBOX_DIR com APP_ENV=%s (o outbox é só para dev/test/e2e)',
    (appEnv) => {
      expect(issues({ ...VALID, APP_ENV: appEnv })).toContain('MAIL_OUTBOX_DIR:');
      expect(
        parseServerEnv({ ...VALID, APP_ENV: appEnv, MAIL_OUTBOX_DIR: undefined }).mailOutboxDir,
      ).toBeUndefined();
    },
  );

  it('exige caminho absoluto no outbox', () => {
    expect(issues({ ...VALID, MAIL_OUTBOX_DIR: 'relativo/outbox' })).toContain('MAIL_OUTBOX_DIR:');
  });

  it('trata string vazia como ausente', () => {
    expect(parseServerEnv({ ...VALID, MAIL_OUTBOX_DIR: '' }).mailOutboxDir).toBeUndefined();
  });
});
