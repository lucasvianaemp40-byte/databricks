import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, defineConfig, devices } from '@playwright/test';

/**
 * E2E contra o build de PRODUÇÃO (`next build && next start`): CSP, cabeçalhos e hidratação
 * mudam entre dev e produção, e é a produção que precisa estar certa.
 *
 * Variáveis (todas opcionais; ver apps/web/.env.example):
 * - E2E_BASE_URL: testa um ambiente já no ar (preview); não sobe servidor local.
 * - E2E_PORT: porta do servidor local (padrão 3100).
 * - E2E_SKIP_BUILD=1: reaproveita um `next build` já feito (CI depois do job de build).
 * - E2E_CHROMIUM_EXECUTABLE_PATH: Chromium alternativo (ver resolveChromiumExecutable).
 */
const {
  CI,
  E2E_BASE_URL,
  E2E_CHROMIUM_EXECUTABLE_PATH,
  E2E_PORT,
  E2E_SKIP_BUILD,
  PLAYWRIGHT_BROWSERS_PATH,
  TEST_WORKER_INDEX,
} = process.env;

const isCI = Boolean(CI);
const port = Number(E2E_PORT ?? '3100');
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`E2E_PORT inválida: use um número de porta entre 1 e 65535.`);
}
// 127.0.0.1 em vez de localhost: evita resolver para ::1 enquanto o servidor escuta em IPv4.
const localOrigin = `http://127.0.0.1:${port}`;
const baseURL = E2E_BASE_URL ?? localOrigin;

/**
 * Chromium a usar. Em CI, sempre o da versão do Playwright (instalado com
 * `playwright install --with-deps chromium`). Fora de CI, se esse não estiver baixado (ex.:
 * container sem acesso ao CDN do Playwright), usa a maior revisão em PLAYWRIGHT_BROWSERS_PATH.
 * Versão de navegador diferente da esperada pode divergir em detalhes: o CI é a referência.
 */
function resolveChromiumExecutable(): string | undefined {
  if (E2E_CHROMIUM_EXECUTABLE_PATH) {
    return E2E_CHROMIUM_EXECUTABLE_PATH;
  }
  if (isCI || existsSync(chromium.executablePath())) {
    return undefined;
  }
  const browsersDir = PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(browsersDir)) {
    return undefined;
  }
  const revisions = readdirSync(browsersDir)
    .map((entry) => /^chromium-(\d+)$/.exec(entry))
    .filter((match) => match !== null)
    .map((match) => ({ dir: match[0], revision: Number(match[1]) }))
    .sort((a, b) => b.revision - a.revision);
  for (const { dir } of revisions) {
    for (const binary of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(browsersDir, dir, binary);
      if (existsSync(candidate)) {
        if (TEST_WORKER_INDEX === undefined) {
          // Só no processo principal: a config é recarregada em cada worker.
          console.warn(`[e2e] Chromium do Playwright ausente; usando ${candidate}.`);
        }
        return candidate;
      }
    }
  }
  return undefined;
}

const executablePath = resolveChromiumExecutable();
const launchOptions = executablePath === undefined ? {} : { executablePath };
// Vídeo depende do ffmpeg da mesma versão do Playwright; com navegador alternativo ele
// costuma faltar também, então o vídeo fica desligado e sobram trace e screenshot.
const usesBundledBrowsers = executablePath === undefined;
// Sem E2E_BASE_URL a config sobe o build local (webServer abaixo).
const hasLocalBuild = E2E_BASE_URL === undefined;

// Teste que não se aplica a um projeto sai pela config, nunca por um pulo condicional no
// corpo do teste (lint noSkippedTests, plugin no-disabled-tests e src/test-hygiene.test.ts).
// `pnpm --filter @salon/web exec playwright test --list` mostra o que roda em cada projeto. O
// src/test-hygiene.test.ts fixa isso (tabela SPEC_PROJECTS_* e filtros previstos por projeto):
// spec novo ou filtro novo (testIgnore, grep, grepInvert, shard, nos projetos ou na raiz)
// reprova o unit até a tabela e os filtros mudarem no mesmo PR.

/** Cabeçalhos HTTP, a fixture de console e o boot com outra config não dependem do dispositivo. */
const DEVICE_INDEPENDENT_SPECS = /(?:security-headers|console-guard|runtime-env)\.spec\.ts$/;
/** Sobe outro `next start` sobre o .next do webServer: sem build local não há o que testar. */
const LOCAL_BUILD_SPECS = /runtime-env\.spec\.ts$/;
/**
 * Tag dos testes que só fazem sentido no desktop (ex.: navegação por Tab com teclado físico):
 * `test('…', { tag: '@desktop-only' }, …)`. O Playwright casa o grepInvert com
 * "arquivo describe título @tags".
 */
const DESKTOP_ONLY_TAG = /(?:^|\s)@desktop-only(?=\s|$)/;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  // .only quebra a suíte também fora do CI (src/test-hygiene.test.ts fixa isto).
  forbidOnly: true,
  retries: isCI ? 2 : 0,
  ...(isCI ? { workers: '50%' } : {}),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: isCI
    ? [['github'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/junit.xml' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: usesBundledBrowsers ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions },
      ...(hasLocalBuild ? {} : { testIgnore: LOCAL_BUILD_SPECS }),
    },
    {
      // Público majoritariamente Android: celular intermediário popular no Brasil.
      name: 'mobile',
      use: { ...devices['Galaxy A55'], launchOptions },
      // Os specs independentes do dispositivo rodam uma vez, no projeto desktop.
      testIgnore: DEVICE_INDEPENDENT_SPECS,
      grepInvert: DESKTOP_ONLY_TAG,
    },
  ],
  ...(hasLocalBuild
    ? {
        webServer: {
          command: `${E2E_SKIP_BUILD ? '' : 'pnpm run build && '}pnpm run start --port ${port} --hostname 127.0.0.1`,
          url: `${localOrigin}/api/health`,
          // Nunca reaproveita um servidor já aberto: um `next dev` na porta tem outra CSP.
          reuseExistingServer: false,
          timeout: 240_000,
          stdout: 'pipe',
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
          env: {
            APP_ENV: 'e2e',
            APP_URL: localOrigin,
            NEXT_TELEMETRY_DISABLED: '1',
          },
        },
      }
    : {}),
});
