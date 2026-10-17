// @ts-check
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import { createBaseConfig } from '../../eslint.base.mjs';

/** Código React/Next do app. Specs do Playwright e configs não são componentes. */
const appFiles = ['src/**/*.{ts,tsx}'];

// Sem eslint-config-next: ele puxa plugins (import, jsx-a11y, react) que ainda não declaram
// suporte ao ESLint 10. Usamos só os dois plugins que o suportam e foram verificados aqui:
// @next/eslint-plugin-next 16.4 e eslint-plugin-react-hooks 7.1. Acessibilidade fica com o
// Biome (regras a11y) e o axe nos E2E.
export default defineConfig(
  createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    name: 'next/core-web-vitals',
    files: appFiles,
    ...nextPlugin.configs['core-web-vitals'],
  },
  {
    name: 'react-hooks/recommended',
    files: appFiles,
    ...reactHooks.configs.flat.recommended,
  },
  {
    name: 'salon/web-ajustes',
    files: appFiles,
    rules: {
      // Regra do Pages Router; o app usa só o App Router (src/app).
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  {
    name: 'salon/web-ferramentas',
    files: ['playwright.config.ts'],
    rules: {
      // Caminhos de navegador vêm de variáveis de ambiente de quem roda os testes
      // (PLAYWRIGHT_BROWSERS_PATH, E2E_CHROMIUM_EXECUTABLE_PATH), nunca de entrada de usuário.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
);
