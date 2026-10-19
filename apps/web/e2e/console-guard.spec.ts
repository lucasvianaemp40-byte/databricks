import { type ConsoleMessage, expect, type Page, test } from '@playwright/test';
import {
  consoleProblem,
  MISSING_PAGE_DOCUMENT_404,
  MISSING_PAGE_PATH,
  PLATFORM_GATED_PERMISSIONS,
} from './support/console';

/**
 * Testa a classificação da fixture `failOnConsoleErrors` com mensagens REAIS do Chromium.
 * Usa o `test` puro do Playwright (sem a fixture automática), e as páginas são sintéticas:
 * `page.route` responde antes de a requisição chegar ao servidor do app.
 */

const SYNTHETIC_PREFIX = '/__console-guard';

interface SyntheticResponse {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly contentType?: string;
}

// biome-ignore lint/security/noSecrets: HTML mínimo de uma página sintética, não é segredo.
const HTML_PAGE = '<!doctype html><html lang="pt-BR"><title>sonda</title><h1>sonda</h1></html>';

/** Responde cada caminho com o que foi pedido; o resto da origem sintética vira 404. */
async function serve(page: Page, routes: Readonly<Record<string, SyntheticResponse>>) {
  await page.route(
    (url) => url.pathname.startsWith(SYNTHETIC_PREFIX) || url.pathname === MISSING_PAGE_PATH,
    (route) => {
      const { pathname } = new URL(route.request().url());
      const response = routes[pathname] ?? { status: 404, body: 'ausente' };
      return route.fulfill({
        status: response.status ?? 200,
        contentType: response.contentType ?? 'text/html; charset=utf-8',
        headers: response.headers ?? {},
        body: response.body ?? HTML_PAGE,
      });
    },
  );
}

/** Abre a página, espera a rede assentar e devolve as mensagens de console registradas. */
async function consoleOf(page: Page, path: string): Promise<ConsoleMessage[]> {
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => messages.push(message));
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  return messages;
}

function problems(messages: readonly ConsoleMessage[], allowed: readonly RegExp[] = []): string[] {
  return messages
    .map((message) => consoleProblem(message, allowed))
    .filter((problem) => problem !== undefined);
}

test.describe('fixture de console', () => {
  test('reprova Permissions-Policy com recurso desconhecido (o Chromium só emite warning)', async ({
    page,
  }) => {
    await serve(page, {
      [`${SYNTHETIC_PREFIX}/pagina`]: {
        headers: { 'Permissions-Policy': 'camera=(), recurso-inexistente=()' },
      },
    });

    const messages = await consoleOf(page, `${SYNTHETIC_PREFIX}/pagina`);

    const unknownFeature = messages.filter((message) =>
      message.text().includes("Unrecognized feature: 'recurso-inexistente'"),
    );
    expect(
      unknownFeature.map((message) => message.type()),
      'nível que o Chromium usa',
    ).toEqual(['warning']);
    expect(problems(messages)).toEqual([expect.stringContaining('recurso-inexistente')]);
  });

  test('tolera só o aviso exato dos recursos dependentes de plataforma', async ({ page }) => {
    await serve(page, {
      [`${SYNTHETIC_PREFIX}/pagina`]: {
        headers: {
          'Permissions-Policy': [...PLATFORM_GATED_PERMISSIONS, 'outro-inexistente']
            .map((feature) => `${feature}=()`)
            .join(', '),
        },
      },
    });

    const messages = await consoleOf(page, `${SYNTHETIC_PREFIX}/pagina`);

    expect(problems(messages)).toEqual([expect.stringContaining("'outro-inexistente'")]);
  });

  test('reprova Permissions-Policy malformada', async ({ page }) => {
    await serve(page, {
      [`${SYNTHETIC_PREFIX}/pagina`]: {
        headers: { 'Permissions-Policy': 'camera=(, geolocation' },
      },
    });

    const messages = await consoleOf(page, `${SYNTHETIC_PREFIX}/pagina`);

    expect(problems(messages)).toEqual([expect.stringContaining('Permissions-Policy')]);
  });

  test('reprova violação de CSP', async ({ page }) => {
    await serve(page, {
      [`${SYNTHETIC_PREFIX}/pagina`]: {
        headers: { 'Content-Security-Policy': "script-src 'none'" },
        body: `${HTML_PAGE}<script>document.title = 'executou';</script>`,
      },
    });

    const messages = await consoleOf(page, `${SYNTHETIC_PREFIX}/pagina`);

    expect(problems(messages)).toEqual([expect.stringContaining('Content Security Policy')]);
  });

  test('a exceção do 404 vale só para o documento, não para CSS e JS da página', async ({
    page,
  }) => {
    await serve(page, {
      [MISSING_PAGE_PATH]: {
        status: 404,
        body: `<!doctype html><html lang="pt-BR"><title>404</title>
          <link rel="stylesheet" href="${SYNTHETIC_PREFIX}/ausente.css">
          <script src="${SYNTHETIC_PREFIX}/ausente.js"></script><h1>404</h1></html>`,
      },
    });

    const messages = await consoleOf(page, MISSING_PAGE_PATH);

    const found = problems(messages, [MISSING_PAGE_DOCUMENT_404]);
    expect(found).toHaveLength(2);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${SYNTHETIC_PREFIX}/ausente.css`),
        expect.stringContaining(`${SYNTHETIC_PREFIX}/ausente.js`),
      ]),
    );
    expect(found.join('\n')).not.toContain(`${MISSING_PAGE_PATH})`);
  });

  test('sem a exceção, o 404 do próprio documento também reprova', async ({ page }) => {
    await serve(page, { [MISSING_PAGE_PATH]: { status: 404 } });

    const messages = await consoleOf(page, MISSING_PAGE_PATH);

    expect(problems(messages)).toEqual([expect.stringMatching(MISSING_PAGE_DOCUMENT_404)]);
  });
});
