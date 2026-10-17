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

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: isCI,
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
    },
    {
      // Público majoritariamente Android: celular intermediário popular no Brasil.
      name: 'mobile',
      use: { ...devices['Galaxy A55'], launchOptions },
      // Cabeçalhos HTTP não dependem do dispositivo: rodam uma vez, no projeto desktop.
      testIgnore: /security-headers\.spec\.ts$/,
    },
  ],
  ...(E2E_BASE_URL === undefined
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
            NEXT_PUBLIC_APP_URL: localOrigin,
            NEXT_TELEMETRY_DISABLED: '1',
          },
        },
      }
    : {}),
});
