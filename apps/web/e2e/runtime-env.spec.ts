import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';

/**
 * Variáveis de implantação lidas em RUNTIME pelo servidor, não embutidas no build.
 *
 * Uma variável NEXT_PUBLIC_ é embutida pelo Next em todos os bundles (inclusive o do servidor)
 * com o valor do `next build`. Com a origem pública assim, um build de e2e iniciado como
 * produção dizia "Ready" e respondia 500 em toda rota (a validação acusava o valor do build),
 * e um build de preview promovido a produção usava a origem do preview sem avisar.
 *
 * O teste sobe um segundo `next start` sobre o MESMO build do webServer (APP_ENV=e2e, origem
 * http://127.0.0.1:<porta>) com a configuração de produção, e confere que ela é a usada.
 */

const PRODUCTION_ORIGIN = 'https://agenda.exemplo.com.br';
const STARTUP_TIMEOUT_MS = 20_000;

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (address === null || typeof address === 'string') {
    throw new Error('Não foi possível reservar uma porta livre.');
  }
  return address.port;
}

interface StartedServer {
  readonly child: ChildProcess;
  readonly origin: string;
  readonly output: () => string;
}

function startProductionServer(webDir: string, port: number): StartedServer {
  const child = spawn(
    process.execPath,
    [
      join(webDir, 'node_modules/next/dist/bin/next'),
      'start',
      '--port',
      String(port),
      '--hostname',
      '127.0.0.1',
    ],
    {
      cwd: webDir,
      env: {
        ...process.env,
        APP_ENV: 'production',
        APP_URL: PRODUCTION_ORIGIN,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const chunks: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  return { child, origin: `http://127.0.0.1:${port}`, output: () => chunks.join('') };
}

/** Espera o /api/health responder 200; falha cedo se o processo morrer ou responder 5xx. */
async function waitUntilHealthy(request: APIRequestContext, server: StartedServer) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`next start terminou (código ${server.child.exitCode}):\n${server.output()}`);
    }
    const status = await request
      .get(`${server.origin}/api/health`, { timeout: 2_000 })
      .then((response) => response.status())
      .catch(() => undefined);
    if (status === 200) {
      return;
    }
    if (status !== undefined && status >= 500) {
      throw new Error(`/api/health respondeu ${status}:\n${server.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`next start não respondeu em ${STARTUP_TIMEOUT_MS} ms:\n${server.output()}`);
}

async function stop({ child }: StartedServer): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

test.describe('variáveis de implantação lidas em runtime', () => {
  test('o build de e2e iniciado como produção usa a origem e o APP_ENV do runtime', async ({
    request,
  }, testInfo) => {
    // Com E2E_BASE_URL (ambiente já no ar) não há webServer nem build local para reaproveitar:
    // a config tira este spec de todos os projetos (LOCAL_BUILD_SPECS). Se a config mudar e o
    // spec rodar sem o build, falha aqui com o motivo, em vez de passar sem verificar nada.
    expect(testInfo.config.webServer, 'precisa do build local (.next) do webServer').not.toBeNull();
    const webDir = join(testInfo.project.testDir, '..');
    const server = startProductionServer(webDir, await freePort());
    try {
      await waitUntilHealthy(request, server);

      const response = await request.get(`${server.origin}/`);
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toMatch(/<link rel="canonical" href="https:\/\/agenda\.exemplo\.com\.br\/?"/);
      expect(html).toContain('<meta name="robots" content="index, follow"/>');
    } finally {
      await stop(server);
    }
  });
});
