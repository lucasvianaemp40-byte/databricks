import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { env } from '../env';
import './globals.css';

const PRODUCT_NAME = 'Agenda Salão';
const PRODUCT_DESCRIPTION =
  'Agendamento online para salões de beleza e barbearias: seus clientes marcam horário pelo celular e a equipe acompanha a agenda do dia sem conflitos.';

// Só a produção é indexada; preview, e2e e desenvolvimento ficam fora dos buscadores.
const isIndexable = env.APP_ENV === 'production';

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
  title: {
    default: `${PRODUCT_NAME}: agendamento online para salões`,
    template: `%s | ${PRODUCT_NAME}`,
  },
  description: PRODUCT_DESCRIPTION,
  applicationName: PRODUCT_NAME,
  robots: { index: isIndexable, follow: isIndexable },
  // Evita que o iOS transforme números (preços, horários) em links de telefone.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // CSP com nonce exige renderização dinâmica: o Next aplica o nonce da requisição aos
  // scripts durante o SSR. Uma página pré-renderizada no build sairia sem nonce e o
  // navegador bloquearia a hidratação.
  await connection();

  return (
    <html lang="pt-BR">
      <body className="flex min-h-dvh flex-col bg-white font-sans text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <a
          href="#conteudo"
          className="sr-only rounded-md bg-rose-700 px-4 py-2 font-medium text-white focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700"
        >
          Pular para o conteúdo
        </a>
        <header className="border-zinc-200 border-b dark:border-zinc-800">
          <div className="mx-auto flex max-w-5xl items-center px-4 py-4 sm:px-6">
            <span className="font-semibold text-lg tracking-tight">{PRODUCT_NAME}</span>
          </div>
        </header>
        <main id="conteudo" tabIndex={-1} className="flex-1 focus:outline-none">
          {children}
        </main>
        <footer className="border-zinc-200 border-t dark:border-zinc-800">
          <div className="mx-auto max-w-5xl px-4 py-6 text-sm text-zinc-600 sm:px-6 dark:text-zinc-400">
            {PRODUCT_NAME}: agendamento para salões de beleza e barbearias.
          </div>
        </footer>
      </body>
    </html>
  );
}
