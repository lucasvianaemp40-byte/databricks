import { type APIResponse, expect, test } from '@playwright/test';

/**
 * Cabeçalhos de segurança no nível HTTP (sem navegador). O comportamento da CSP no navegador
 * (scripts com nonce executando, nenhuma violação) é coberto pela fixture de console nos
 * demais specs. Rodam contra o build de produção, como em produção.
 */

const NONCE_SOURCE = /'nonce-([A-Za-z0-9+/]{22}==)'/;

function header(response: APIResponse, name: string): string {
  const value = response.headers()[name.toLowerCase()];
  expect(value, `cabeçalho ${name}`).toBeDefined();
  return value ?? '';
}

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter(
        (tokens): tokens is [string, ...string[]] => tokens[0] !== undefined && tokens[0] !== '',
      )
      .map(([name, ...sources]) => [name, sources]),
  );
}

function nonceOf(response: APIResponse): string {
  const nonce = NONCE_SOURCE.exec(header(response, 'content-security-policy'))?.[1];
  expect(nonce, 'nonce de 128 bits na CSP').toBeDefined();
  return nonce ?? '';
}

/** Documento HTML com CSP na resposta e o nonce dela em todos os <script>. */
async function expectDocumentUnderCsp(response: APIResponse): Promise<void> {
  expect(header(response, 'content-type')).toContain('text/html');
  const nonce = nonceOf(response);
  const scripts = (await response.text()).match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length, 'scripts do Next no documento').toBeGreaterThan(0);
  for (const tag of scripts) {
    expect(tag).toContain(`nonce="${nonce}"`);
  }
}

/**
 * Caminhos que o matcher antigo do Proxy deixava sem CSP: exclusão por prefixo solto
 * (`_next/static`, `_next/image`) e '.' sem escape em `favicon.ico`. Todos respondem a página
 * 404 do app, com os scripts do Next. Um slug de salão com esses prefixos (página pública
 * /[slug]) cairia no mesmo caso.
 */
const PATHS_FORMERLY_WITHOUT_PROXY = [
  '/favicon.ico',
  '/favicon.ico.bak',
  '/faviconXico',
  '/favicon-ico-x',
  '/_next/static',
  '/_next/staticX',
  '/_next/static-evil/page',
  '/_next/imagefoo',
];

const STATIC_HEADERS: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-site',
  'x-frame-options': 'DENY',
};

test.describe('Content-Security-Policy', () => {
  test('é estrita, baseada em nonce, sem unsafe-inline/unsafe-eval', async ({ request }) => {
    const response = await request.get('/');
    const csp = directives(header(response, 'content-security-policy'));
    const nonce = nonceOf(response);

    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
    expect(csp.get('style-src')).toEqual(["'self'", `'nonce-${nonce}'`]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
    const allSources = [...csp.values()].flat();
    expect(allSources).not.toContain("'unsafe-inline'");
    expect(allSources).not.toContain("'unsafe-eval'");
  });

  test('gera nonce diferente a cada requisição', async ({ request }) => {
    const nonces = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      nonces.add(nonceOf(await request.get('/')));
    }
    expect(nonces.size).toBe(5);
  });

  test('aplica o nonce da resposta a todos os <script> e folhas de estilo', async ({ request }) => {
    const response = await request.get('/');
    const nonce = nonceOf(response);
    const html = await response.text();

    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
    // Atributos style="…" seriam bloqueados pela style-src sem 'unsafe-inline'.
    expect(html).not.toMatch(/\sstyle="/);
  });

  test('ignora nonce e CSP forjados pelo cliente', async ({ request }) => {
    const forgedNonce = `${'A'.repeat(22)}==`;
    const response = await request.get('/', {
      headers: {
        'x-nonce': forgedNonce,
        'content-security-policy': `script-src 'nonce-${forgedNonce}'`,
      },
    });
    const nonce = nonceOf(response);
    expect(nonce).not.toBe(forgedNonce);
    expect(await response.text()).not.toContain(forgedNonce);
  });
});

test.describe('cobertura do Proxy', () => {
  for (const path of PATHS_FORMERLY_WITHOUT_PROXY) {
    test(`a página 404 em ${path} sai com CSP e nonce em todos os <script>`, async ({
      request,
    }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(404);
      await expectDocumentUnderCsp(response);
    });
  }

  test('ignora nonce e CSP forjados também fora das rotas do app', async ({ request }) => {
    const forgedNonce = `${'A'.repeat(22)}==`;
    const response = await request.get('/favicon.ico.bak', {
      headers: { 'content-security-policy': `script-src 'nonce-${forgedNonce}'` },
    });
    expect(nonceOf(response)).not.toBe(forgedNonce);
    expect(await response.text()).not.toContain(forgedNonce);
  });

  // Cabeçalhos de prefetch são controlados pelo cliente: não podem tirar a CSP do HTML.
  for (const [name, value] of [
    ['next-router-prefetch', '1'],
    ['next-router-prefetch', 'qualquer-valor'],
    ['purpose', 'prefetch'],
  ] as const) {
    test(`o HTML pedido com ${name}: ${value} sai com CSP`, async ({ request }) => {
      const response = await request.get('/', { headers: { [name]: value } });
      expect(response.status()).toBe(200);
      await expectDocumentUnderCsp(response);
    });
  }
});

test.describe('otimizador de imagens', () => {
  test('/_next/image está desligado: 404 com a página do app, sob CSP', async ({ request }) => {
    // Com o otimizador ligado, o Next buscaria "/" internamente e responderia 400.
    const response = await request.get('/_next/image', {
      params: { url: '/', w: '64', q: '75' },
    });
    expect(response.status()).toBe(404);
    await expectDocumentUnderCsp(response);
  });
});

test.describe('método TRACE', () => {
  // O adaptador do Proxy no Next 16.4 não monta um Request com TRACE (o Fetch o proíbe) e
  // responde 500 sem os cabeçalhos estáticos, antes de proxy() rodar; o bloqueio com 405 é
  // da borda (ver README). Aqui fica o mínimo que o app garante: nada da requisição ecoado
  // (Cross-Site Tracing) e nenhum detalhe interno no corpo.
  for (const path of ['/', '/api/health']) {
    test(`TRACE em ${path} não ecoa a requisição nem vaza stack`, async ({ request }) => {
      const marker = `sonda-trace-${crypto.randomUUID()}`;
      const response = await request.fetch(path, {
        method: 'TRACE',
        headers: { 'x-sonda-trace': marker, cookie: `sonda=${marker}` },
      });
      const body = await response.text();

      expect(body).not.toContain(marker);
      expect(body).not.toContain('TypeError');
      expect(body).not.toMatch(/\n\s+at /);
      expect(body).not.toContain('.next/');
      expect(body).not.toContain('chunks/');
    });
  }
});

test.describe('cabeçalhos estáticos', () => {
  for (const path of ['/', '/api/health', '/pagina-que-nao-existe']) {
    test(`presentes em ${path}, sem X-Powered-By`, async ({ request }) => {
      const response = await request.get(path);
      const headers = response.headers();

      for (const [name, value] of Object.entries(STATIC_HEADERS)) {
        expect(headers[name], name).toBe(value);
      }
      const permissionsPolicy = header(response, 'permissions-policy');
      for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
        expect(permissionsPolicy).toContain(`${feature}=()`);
      }
      // Passkeys da equipe dependem de WebAuthn: não pode estar bloqueado.
      expect(permissionsPolicy).not.toContain('publickey-credentials');
      expect(headers).not.toHaveProperty('x-powered-by');
      expect(headers).toHaveProperty('content-security-policy');
    });
  }

  test('valem também para assets estáticos (fora do Proxy, sem CSP)', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const stylesheet = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/.exec(html)?.[1];
    expect(stylesheet, 'folha de estilo do Tailwind').toBeDefined();

    const response = await request.get(stylesheet ?? '');
    expect(response.status()).toBe(200);
    const headers = response.headers();
    for (const [name, value] of Object.entries(STATIC_HEADERS)) {
      expect(headers[name], name).toBe(value);
    }
    expect(headers).not.toHaveProperty('x-powered-by');
  });
});

test.describe('/api/health', () => {
  test('responde {status:"ok"} sem cache e sem detalhes de infraestrutura', async ({ request }) => {
    const response = await request.get('/api/health');

    expect(response.status()).toBe(200);
    expect(header(response, 'content-type')).toContain('application/json');
    expect(header(response, 'cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok' });
    const headers = response.headers();
    expect(headers).not.toHaveProperty('x-powered-by');
    expect(headers).not.toHaveProperty('server');
  });

  test('só aceita leitura', async ({ request }) => {
    const response = await request.post('/api/health', { data: {} });
    expect(response.status()).toBe(405);
  });
});
