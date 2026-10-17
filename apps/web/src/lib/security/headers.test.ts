import { describe, expect, it } from 'vitest';
import {
  DENIED_PERMISSIONS,
  HSTS_VALUE,
  PERMISSIONS_POLICY_VALUE,
  staticSecurityHeaders,
} from './headers';

function asRecord(includeHsts: boolean): Record<string, string> {
  const headers = staticSecurityHeaders({ includeHsts });
  const keys = headers.map(({ key }) => key.toLowerCase());
  expect(new Set(keys).size, 'cabeçalho duplicado').toBe(keys.length);
  return Object.fromEntries(headers.map(({ key, value }) => [key, value]));
}

describe('staticSecurityHeaders', () => {
  const production = asRecord(true);

  it('envia os cabeçalhos exigidos pelo ASVS 3.4 com os valores do projeto', () => {
    expect(production).toEqual({
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': PERMISSIONS_POLICY_VALUE,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-site',
      'X-Frame-Options': 'DENY',
    });
  });

  it('usa HSTS de pelo menos 1 ano com subdomínios e sem preload', () => {
    const maxAge = Number(/max-age=(\d+)/.exec(HSTS_VALUE)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(31_536_000);
    expect(maxAge).toBe(2 * 365 * 24 * 60 * 60);
    expect(HSTS_VALUE).toContain('includeSubDomains');
    expect(HSTS_VALUE).not.toContain('preload');
  });

  it('omite HSTS fora do build de produção e mantém o restante', () => {
    const development = asRecord(false);
    expect(development).not.toHaveProperty('Strict-Transport-Security');
    const { 'Strict-Transport-Security': _hsts, ...rest } = production;
    expect(development).toEqual(rest);
  });
});

describe('Permissions-Policy', () => {
  it('nega câmera, microfone, geolocalização e pagamento', () => {
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(PERMISSIONS_POLICY_VALUE).toContain(`${feature}=()`);
    }
  });

  it('não bloqueia passkeys (WebAuthn) nem WebOTP', () => {
    for (const feature of [
      'publickey-credentials-get',
      'publickey-credentials-create',
      'otp-credentials',
    ]) {
      expect(PERMISSIONS_POLICY_VALUE).not.toContain(feature);
    }
  });

  it('serializa como lista estruturada (RFC 8941) com allowlist vazia', () => {
    expect(PERMISSIONS_POLICY_VALUE.split(', ')).toEqual(
      DENIED_PERMISSIONS.map((feature) => `${feature}=()`),
    );
    expect(new Set(DENIED_PERMISSIONS).size).toBe(DENIED_PERMISSIONS.length);
  });
});
