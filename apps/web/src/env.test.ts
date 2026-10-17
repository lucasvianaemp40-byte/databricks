import { describe, expect, it } from 'vitest';
import { createAppEnv, InvalidEnvironmentError, type RuntimeEnv } from './env';

const EMPTY: RuntimeEnv = {
  APP_ENV: undefined,
  NEXT_PUBLIC_APP_URL: undefined,
  NODE_ENV: undefined,
};

/** Monta a URL com usuário e senha sem deixar uma credencial literal no código. */
function urlWithCredentials(origin: string): string {
  const url = new URL(origin);
  url.username = 'usuario';
  url.password = 'nao-e-segredo';
  // Sem a barra final que o URL acrescenta: o caso precisa falhar só pelas credenciais.
  return url.href.replace(/\/$/, '');
}

function serverEnv(overrides: Partial<RuntimeEnv>) {
  return createAppEnv({ ...EMPTY, ...overrides }, { isServer: true });
}

describe('createAppEnv (servidor)', () => {
  it('usa padrões seguros para desenvolvimento local', () => {
    const env = serverEnv({});
    expect(env.APP_ENV).toBe('development');
    expect(env.NODE_ENV).toBe('development');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
  });

  it('trata string vazia como ausente (linha "VAR=" em .env)', () => {
    const env = serverEnv({ APP_ENV: '', NEXT_PUBLIC_APP_URL: '' });
    expect(env.APP_ENV).toBe('development');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
  });

  it('não altera o objeto recebido', () => {
    const runtimeEnv: RuntimeEnv = { ...EMPTY, APP_ENV: '' };
    createAppEnv(runtimeEnv, { isServer: true });
    expect(runtimeEnv).toHaveProperty('APP_ENV', '');
  });

  it('aceita a configuração de produção com origem https', () => {
    const env = serverEnv({
      APP_ENV: 'production',
      NODE_ENV: 'production',
      NEXT_PUBLIC_APP_URL: 'https://agenda.exemplo.com.br',
    });
    expect(env.APP_ENV).toBe('production');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('https://agenda.exemplo.com.br');
  });

  it('aceita build de produção servido em http local para e2e', () => {
    const env = serverEnv({
      APP_ENV: 'e2e',
      NODE_ENV: 'production',
      NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3100',
    });
    expect(env.APP_ENV).toBe('e2e');
  });

  it('rejeita APP_ENV desconhecido citando a variável, sem ecoar o valor', () => {
    const secretLooking = 'nao-pode-aparecer-no-erro';
    expect(() => serverEnv({ APP_ENV: secretLooking })).toThrow(InvalidEnvironmentError);
    try {
      serverEnv({ APP_ENV: secretLooking });
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      const { message } = error as InvalidEnvironmentError;
      expect(message).toContain('APP_ENV');
      expect(message).not.toContain(secretLooking);
    }
  });

  it('rejeita NODE_ENV fora do padrão do Node', () => {
    expect(() => serverEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it.each([
    ['sem protocolo', 'agenda.exemplo.com.br'],
    ['protocolo não http', 'ftp://agenda.exemplo.com.br'],
    ['javascript:', 'javascript:alert(1)'],
    ['com caminho', 'https://agenda.exemplo.com.br/painel'],
    ['com barra final', 'https://agenda.exemplo.com.br/'],
    ['com query', 'https://agenda.exemplo.com.br?x=1'],
    ['com fragmento', 'https://agenda.exemplo.com.br#topo'],
    ['com credenciais', urlWithCredentials('https://agenda.exemplo.com.br')],
  ])('rejeita NEXT_PUBLIC_APP_URL %s', (_case, url) => {
    expect(() => serverEnv({ NEXT_PUBLIC_APP_URL: url })).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it.each([
    ['padrão localhost', undefined],
    ['http', 'http://agenda.exemplo.com.br'],
    ['https em localhost', 'https://localhost:3000'],
    ['https em 127.0.0.1', 'https://127.0.0.1'],
    ['https em [::1]', 'https://[::1]:8443'],
  ])('em produção, exige origem pública em https (%s)', (_case, url) => {
    expect(() =>
      serverEnv({ APP_ENV: 'production', NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: url }),
    ).toThrow(/NEXT_PUBLIC_APP_URL.*https/);
  });

  it('lista todas as variáveis inválidas de uma vez', () => {
    expect(() => serverEnv({ APP_ENV: 'x', NEXT_PUBLIC_APP_URL: 'y', NODE_ENV: 'z' })).toThrow(
      /APP_ENV[\s\S]*NEXT_PUBLIC_APP_URL[\s\S]*NODE_ENV|APP_ENV[\s\S]*NODE_ENV[\s\S]*NEXT_PUBLIC_APP_URL/,
    );
  });
});

describe('createAppEnv (cliente)', () => {
  const clientEnv = createAppEnv(
    { ...EMPTY, NEXT_PUBLIC_APP_URL: 'https://agenda.exemplo.com.br', NODE_ENV: 'production' },
    { isServer: false },
  );

  it('expõe variáveis NEXT_PUBLIC_ e compartilhadas', () => {
    expect(clientEnv.NEXT_PUBLIC_APP_URL).toBe('https://agenda.exemplo.com.br');
    expect(clientEnv.NODE_ENV).toBe('production');
  });

  it('lança erro ao ler variável de servidor no navegador', () => {
    expect(() => clientEnv.APP_ENV).toThrow(/server-side/);
  });

  it('não valida variáveis de servidor no navegador (elas não existem lá)', () => {
    expect(() =>
      createAppEnv({ ...EMPTY, APP_ENV: 'invalido' }, { isServer: false }),
    ).not.toThrow();
  });
});
