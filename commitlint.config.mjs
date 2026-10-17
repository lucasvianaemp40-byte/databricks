// @ts-check
// Conventional Commits: <tipo>(<escopo>): <assunto>. Assunto em pt-BR, no imperativo,
// por exemplo "feat(core): adiciona cálculo de horários livres".
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Siglas e nomes próprios (LGPD, RLS, Pix, WhatsApp) aparecem em qualquer posição do
    // assunto em pt-BR, então a caixa do assunto é livre.
    'subject-case': [0],
    // Aviso (não bloqueia): escopos conhecidos do monorepo.
    'scope-enum': [
      1,
      'always',
      ['web', 'core', 'db', 'ci', 'claude', 'docs', 'deps', 'repo', 'security'],
    ],
  },
};
