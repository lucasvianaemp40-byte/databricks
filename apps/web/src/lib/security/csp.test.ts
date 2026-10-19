import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, type CspMode, cspDirectives, serializeCsp } from './csp';
import { generateNonce } from './nonce';

const NONCE = generateNonce((bytes) => bytes.map((_, index) => index * 7));

/** Interpreta o cabeçalho como o navegador: diretiva -> lista de fontes. */
function parseCsp(header: string): Map<string, string[]> {
  const parsed = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const [directive, ...sources] = part.trim().split(/\s+/);
    if (directive === undefined || directive === '') {
      continue;
    }
    expect(parsed.has(directive), `diretiva duplicada: ${directive}`).toBe(false);
    parsed.set(directive, sources);
  }
  return parsed;
}

function policy(mode: CspMode): Map<string, string[]> {
  return parseCsp(buildContentSecurityPolicy({ nonce: NONCE, mode }));
}

describe('buildContentSecurityPolicy em produção', () => {
  const csp = policy('production');

  it('permite só scripts com o nonce da resposta e os que eles carregarem', () => {
    expect(csp.get('script-src')).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
  });

  it('usa nonce em style-src, sem unsafe-inline', () => {
    expect(csp.get('style-src')).toEqual(["'self'", `'nonce-${NONCE}'`]);
  });

  it('fecha as diretivas que não herdam de default-src', () => {
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
  });

  it('restringe imagens, fontes e conexões à própria origem', () => {
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(csp.get('font-src')).toEqual(["'self'"]);
    expect(csp.get('connect-src')).toEqual(["'self'"]);
  });

  it('pede upgrade de requisições inseguras', () => {
    expect(csp.get('upgrade-insecure-requests')).toEqual([]);
  });

  it('não tem nenhuma fonte insegura nem curinga', () => {
    const allSources = [...csp.values()].flat();
    for (const unsafe of [
      "'unsafe-inline'",
      "'unsafe-eval'",
      "'unsafe-hashes'",
      '*',
      'http:',
      'https:',
    ]) {
      expect(allSources).not.toContain(unsafe);
    }
  });
});

describe('buildContentSecurityPolicy em desenvolvimento', () => {
  const csp = policy('development');

  it("acrescenta 'unsafe-eval' a script-src para as pilhas de erro do React", () => {
    expect(csp.get('script-src')).toEqual([
      "'self'",
      `'nonce-${NONCE}'`,
      "'strict-dynamic'",
      "'unsafe-eval'",
    ]);
  });

  it("troca o nonce de style-src por 'unsafe-inline' (o HMR injeta <style> sem nonce)", () => {
    // Com um nonce presente o navegador ignoraria 'unsafe-inline'.
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('nunca libera unsafe-inline em script-src', () => {
    expect(csp.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('não força HTTPS no servidor local', () => {
    expect(csp.has('upgrade-insecure-requests')).toBe(false);
  });

  it('mantém as demais restrições da produção', () => {
    const production = policy('production');
    for (const directive of [
      'default-src',
      'object-src',
      'base-uri',
      'frame-ancestors',
      'form-action',
      'connect-src',
    ]) {
      expect(csp.get(directive), directive).toEqual(production.get(directive));
    }
  });
});

describe('validação do nonce', () => {
  it.each([
    ['vazio', ''],
    ['injeção de diretiva', "abc'; script-src *; '"],
    ['quebra de linha', `${NONCE}\r\nX-Injected: 1`],
    ['curto demais (menos de 128 bits)', `${NONCE.slice(0, 14)}==`],
    ['base64url em vez de base64', `${NONCE.slice(0, 20)}-_==`],
    ['sem padding', NONCE.slice(0, 22)],
  ])('rejeita nonce %s', (_case, nonce) => {
    expect(() => buildContentSecurityPolicy({ nonce, mode: 'production' })).toThrow(TypeError);
  });
});

describe('serializeCsp', () => {
  it('separa diretivas por "; " e fontes por espaço, preservando a ordem', () => {
    expect(
      serializeCsp([
        ['default-src', ["'self'"]],
        ['upgrade-insecure-requests', []],
        ['img-src', ["'self'", 'data:']],
      ]),
    ).toBe("default-src 'self'; upgrade-insecure-requests; img-src 'self' data:");
  });

  it('gera um valor de cabeçalho sem quebras de linha', () => {
    for (const mode of ['production', 'development'] as const) {
      expect(buildContentSecurityPolicy({ nonce: NONCE, mode })).not.toMatch(/[\r\n]/);
    }
  });

  it('é determinístico para a mesma entrada (função pura)', () => {
    const options = { nonce: NONCE, mode: 'production' } as const;
    expect(buildContentSecurityPolicy(options)).toBe(buildContentSecurityPolicy(options));
    expect(cspDirectives(options)).toEqual(cspDirectives(options));
  });
});
