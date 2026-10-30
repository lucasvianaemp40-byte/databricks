import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { formatAuthLog } = await import('./logger');

describe('logger do Better Auth sem dado pessoal', () => {
  it('mascara e-mail, IP e token na mensagem', () => {
    const line = formatAuthLog(
      'info',
      'Sign-up attempt for existing email: ana.souza+teste@example.test from 203.0.113.7 token eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFuYUBleGFtcGxlIn0.abc',
      [],
    );
    expect(line).toBe(
      '[auth] info: Sign-up attempt for existing email: [e-mail] from [ip] token [token]',
    );
  });

  it('não imprime argumentos extras: só o nome do erro e o SQLSTATE', () => {
    const driverError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (email)=(ana@example.test) already exists.',
    });
    const wrapped = new Error('Failed query: insert ... params: ana@example.test,Ana', {
      cause: driverError,
    });
    const line = formatAuthLog('error', 'Failed to create user', [wrapped, { email: 'x@y.z' }]);
    expect(line).toBe('[auth] error: Failed to create user [Error (SQLSTATE 23505)]');
    expect(line).not.toContain('example.test');
  });
});
