/**
 * Cabeçalhos de segurança estáticos (iguais em toda resposta), aplicados pelo next.config.ts.
 * A CSP não está aqui: ela depende do nonce de cada requisição e é montada no Proxy.
 *
 * Referências: ASVS 5.0 capítulo 3.4 (nível 2) e docs/seguranca/headers-e-csp.md (decisões do projeto).
 */

export interface HttpHeader {
  readonly key: string;
  readonly value: string;
}

/** HSTS de 2 anos com subdomínios (ASVS 3.4.1 L2). */
export const HSTS_VALUE = 'max-age=63072000; includeSubDomains';

/**
 * Recursos do navegador negados a esta origem e a qualquer iframe.
 *
 * Fora da lista de propósito (continuam no padrão 'self'):
 * - publickey-credentials-get/create: passkeys (WebAuthn) do login da equipe;
 * - otp-credentials: WebOTP, para preencher o código recebido por SMS;
 * - identity-credentials-get, clipboard-write, fullscreen, web-share.
 * Recursos do Privacy Sandbox (browsing-topics, attribution-reporting etc.) foram aposentados
 * pelo Chrome; o navegador acusa erro no console para nomes que não reconhece, e a CSP já
 * impede scripts de terceiros que os usariam.
 */
export const DENIED_PERMISSIONS = [
  'accelerometer',
  'autoplay',
  'bluetooth',
  'camera',
  'clipboard-read',
  'display-capture',
  'encrypted-media',
  'gamepad',
  'geolocation',
  'gyroscope',
  'hid',
  'idle-detection',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'picture-in-picture',
  'screen-wake-lock',
  'serial',
  'usb',
  'window-management',
  'xr-spatial-tracking',
] as const;

export const PERMISSIONS_POLICY_VALUE = DENIED_PERMISSIONS.map((feature) => `${feature}=()`).join(
  ', ',
);

export interface StaticSecurityHeadersOptions {
  /**
   * Envia Strict-Transport-Security. Só em build de produção: em `next dev` com HTTPS local o
   * navegador fixaria HTTPS em localhost por 2 anos e quebraria outros projetos na máquina.
   * O `preload` não é enviado: entrar na lista de preload exige HTTPS em todos os subdomínios
   * do domínio definitivo e é difícil de reverter (ver docs/seguranca/headers-e-csp.md).
   */
  readonly includeHsts: boolean;
}

export function staticSecurityHeaders({
  includeHsts,
}: StaticSecurityHeadersOptions): readonly HttpHeader[] {
  return [
    ...(includeHsts ? [{ key: 'Strict-Transport-Security', value: HSTS_VALUE }] : []),
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: PERMISSIONS_POLICY_VALUE },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
    // Legado (navegadores sem CSP2); o controle efetivo é frame-ancestors 'none' na CSP.
    { key: 'X-Frame-Options', value: 'DENY' },
  ];
}
