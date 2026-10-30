/**
 * Boot do servidor (`next start`/`next dev`, nunca o `next build`): valida as variáveis só
 * de servidor (banco e autenticação). Faltou ou sobrou algo, o servidor não sobe.
 */
export async function register(): Promise<void> {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: definida pelo próprio Next ao subir o servidor.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { serverEnv } = await import('./server/env');
    serverEnv();
  }
}
