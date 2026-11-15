import { describe, expect, it } from 'vitest';
import { createAppEnv, InvalidEnvironmentError, type RuntimeEnv } from './env';

const EMPTY: RuntimeEnv = {
  APP_ENV: undefined,
  APP_URL: undefined,
  NODE_ENV: undefined,
  DATABASE_URL: undefined,
  AUTH_DATABASE_URL: undefined,
  BETTER_AUTH_SECRET: undefined,
};

/** URL PostgreSQL de teste com usuário e senha montados (sem credencial literal no código). */
function pgUrl(user: string, protocol = 'postgresql:'): string {
  const url = new URL('postgresql://127.0.0.1:5432/app');
  url.username = user;
  url.password = 'nao-e-segredo';
  return url.href.replace(/^postgresql:/, protocol);
}

/** As três variáveis da autenticação, válidas. */
function authEnv(overrides: Partial<RuntimeEnv> = {}): Partial<RuntimeEnv> {
  return {
    DATABASE_URL: pgUrl('app_user'),
    AUTH_DATABASE_URL: pgUrl('app_auth'),
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    ...overrides,
  };
}

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
    expect(env.APP_URL).toBe('http://localhost:3000');
  });

  it('trata string vazia como ausente (linha "VAR=" em .env)', () => {
    const env = serverEnv({ APP_ENV: '', APP_URL: '' });
    expect(env.APP_ENV).toBe('development');
    expect(env.APP_URL).toBe('http://localhost:3000');
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
      APP_URL: 'https://agenda.exemplo.com.br',
    });
    expect(env.APP_ENV).toBe('production');
    expect(env.APP_URL).toBe('https://agenda.exemplo.com.br');
  });

  it('aceita build de produção servido em http local para e2e', () => {
    const env = serverEnv({
      APP_ENV: 'e2e',
      NODE_ENV: 'production',
      APP_URL: 'http://127.0.0.1:3100',
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
  ])('rejeita APP_URL %s', (_case, url) => {
    expect(() => serverEnv({ APP_URL: url })).toThrow(/APP_URL/);
  });

  it.each([
    ['padrão localhost', undefined],
    ['http', 'http://agenda.exemplo.com.br'],
    ['https em localhost', 'https://localhost:3000'],
    ['https em 127.0.0.1', 'https://127.0.0.1'],
    ['https em [::1]', 'https://[::1]:8443'],
  ])('em produção, exige origem pública em https (%s)', (_case, url) => {
    expect(() =>
      serverEnv({ APP_ENV: 'production', NODE_ENV: 'production', APP_URL: url }),
    ).toThrow(/APP_URL.*https/);
  });

  it('lista todas as variáveis inválidas de uma vez', () => {
    expect(() => serverEnv({ APP_ENV: 'x', APP_URL: 'y', NODE_ENV: 'z' })).toThrow(
      /APP_ENV[\s\S]*APP_URL[\s\S]*NODE_ENV|APP_ENV[\s\S]*NODE_ENV[\s\S]*APP_URL/,
    );
  });
});

describe('createAppEnv (cliente)', () => {
  const clientEnv = createAppEnv(
    { ...EMPTY, APP_URL: 'https://agenda.exemplo.com.br', NODE_ENV: 'production' },
    { isServer: false },
  );

  it('expõe as variáveis compartilhadas', () => {
    expect(clientEnv.NODE_ENV).toBe('production');
  });

  it.each(['APP_ENV', 'APP_URL'] as const)(
    'lança erro ao ler a variável de servidor %s no navegador',
    (name) => {
      expect(() => clientEnv[name]).toThrow(/server-side/);
    },
  );

  it('não valida variáveis de servidor no navegador (elas não existem lá)', () => {
    expect(() =>
      createAppEnv({ ...EMPTY, APP_ENV: 'invalido', APP_URL: 'invalida' }, { isServer: false }),
    ).not.toThrow();
  });
});

describe('createAppEnv: banco e autenticação', () => {
  it('são opcionais: sem nenhuma das três o app sobe (landing e health não usam banco)', () => {
    const env = serverEnv({});
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AUTH_DATABASE_URL).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it('aceita as três juntas (postgres:// ou postgresql://)', () => {
    const env = serverEnv(authEnv({ AUTH_DATABASE_URL: pgUrl('app_auth', 'postgres:') }));
    expect(env.DATABASE_URL).toBe(pgUrl('app_user'));
    expect(env.BETTER_AUTH_SECRET).toHaveLength(32);
  });

  it.each([
    ['só o banco da aplicação', { AUTH_DATABASE_URL: undefined, BETTER_AUTH_SECRET: undefined }],
    ['sem o segredo', { BETTER_AUTH_SECRET: undefined }],
    ['sem o banco da autenticação', { AUTH_DATABASE_URL: undefined }],
  ])('recusa configuração pela metade: %s', (_label, override) => {
    expect(() => serverEnv(authEnv(override))).toThrow(
      /defina DATABASE_URL, AUTH_DATABASE_URL e BETTER_AUTH_SECRET juntas/,
    );
  });

  it.each([
    ['DATABASE_URL', { DATABASE_URL: pgUrl('app_user', 'mysql:') }],
    ['AUTH_DATABASE_URL', { AUTH_DATABASE_URL: 'nao-e-url' }],
  ])(
    '%s precisa ser URL PostgreSQL, e o erro não ecoa o valor (tem senha)',
    (variable, override) => {
      try {
        serverEnv(authEnv(override));
        expect.unreachable('deveria recusar');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidEnvironmentError);
        const { message } = error as InvalidEnvironmentError;
        expect(message).toContain(variable);
        expect(message).not.toContain('nao-e-segredo');
        expect(message).not.toContain('nao-e-url');
      }
    },
  );

  it('BETTER_AUTH_SECRET precisa de pelo menos 32 caracteres, sem ecoar o valor', () => {
    const short = 'segredo-curto-demais';
    try {
      serverEnv(authEnv({ BETTER_AUTH_SECRET: short }));
      expect.unreachable('deveria recusar');
    } catch (error) {
      const { message } = error as InvalidEnvironmentError;
      expect(message).toContain('BETTER_AUTH_SECRET');
      expect(message).not.toContain(short);
    }
  });

  it('o banco da aplicação e o da autenticação usam papéis diferentes (app_user ≠ app_auth)', () => {
    expect(() => serverEnv(authEnv({ AUTH_DATABASE_URL: pgUrl('app_user') }))).toThrow(
      /AUTH_DATABASE_URL.*outro papel/,
    );
  });
});
