// @ts-check
// Lint dos arquivos de configuração da raiz. Cada pacote tem o próprio eslint.config.mjs
// estendendo eslint.base.mjs; o ESLint 10 resolve a config a partir do diretório de cada
// arquivo, e `pnpm lint` roda o ESLint de cada pacote via turbo.
import { defineConfig } from 'eslint/config';
import { createBaseConfig } from './eslint.base.mjs';

export default defineConfig(createBaseConfig({ tsconfigRootDir: import.meta.dirname }));
