// @ts-check
import { defineConfig } from 'eslint/config';
import { createBaseConfig, testFiles } from '../../eslint.base.mjs';

export default defineConfig(createBaseConfig({ tsconfigRootDir: import.meta.dirname }), {
  name: 'salon-db/testes-com-arquivos-temporarios',
  files: [...testFiles, 'src/**/*.test.ts'],
  rules: {
    // Os testes de migração copiam e editam pastas temporárias (mkdtemp) e montam regex a
    // partir de constantes do próprio pacote: não há entrada de usuário envolvida.
    'security/detect-non-literal-fs-filename': 'off',
    'security/detect-non-literal-regexp': 'off',
  },
});
