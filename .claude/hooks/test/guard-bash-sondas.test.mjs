// @ts-check
/**
 * Contornos do guard-bash confirmados por sondas reais em 2026-10-18 (vim/ex em lote, cópia
 * para pasta e `patch`). Cada caso `deny` ou `ask` daqui passava com decisão mais fraca
 * antes da correção; os casos `none` protegem o fluxo normal contra falso positivo.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateBashCommand } from '../lib/bash-policy.mjs';
import { PROJECT_ROOT } from '../test-support/helpers.mjs';

/** @returns {import('../lib/bash-policy.mjs').PolicyContext} */
function ctx() {
  return {
    cwd: PROJECT_ROOT,
    projectDir: PROJECT_ROOT,
    currentBranch: () => 'claude/feature-x',
    existsOnDefaultBranch: () => ({ exists: false, ref: null, rel: null }),
  };
}

/**
 * @param {string} title
 * @param {Array<[string, 'deny' | 'ask' | 'none']>} cases
 */
function table(title, cases) {
  describe(title, () => {
    for (const [command, expected] of cases) {
      it(`${expected.padEnd(4)} ${JSON.stringify(command)}`, () => {
        const result = evaluateBashCommand(command, ctx());
        assert.equal(result.decision ?? 'none', expected, result.reasons.join(' | '));
        if (expected !== 'none') assert.ok(result.reasons.length > 0, 'decisão sem motivo');
      });
    }
  });
}

table('vim/ex: valor de -c agrupado com outras opções (-sc, -esc, -ec) e anexado', [
  ["ex -sc '!cat .env' -c q", 'deny'],
  ["vim -esc '!cat .env'", 'deny'],
  ["vim -ec '!rm -rf ~'", 'deny'],
  ["ex -sc '!git push --force origin main' -c q", 'deny'],
  ["vim '-c!cat .env' -c q", 'deny'],
  ["nvim -esc '!cat .env'", 'deny'],
  ["ex -sc '!ls' -c q", 'ask'],
  ["ex -sc '%p' -c 'q!' README.md", 'none'],
  ['vim -esc wq notas.txt', 'none'],
]);

table('vim/ex: comando Ex que grava arquivo em -c, --cmd ou +cmd', [
  ["vim -es -c 'w .claude/settings.json' -c q x", 'deny'],
  ["ex -sc 'w! .claude/settings.json' -c q x", 'deny'],
  ["vim -c 'saveas .claude/settings.json' -c q x", 'deny'],
  ["vim -es '+w .claude/hooks/guard-bash.mjs' +q x", 'deny'],
  ["vim -es -c 'w >> .claude/settings.json' -c q x", 'deny'],
  ["vim -es -c 'w>>.claude/settings.json' -c q x", 'deny'],
  ["vim -es -c '%w! .claude/hooks/x.mjs' -c q x", 'deny'],
  ["vim -es -c '1,$write .claude/settings.local.json' -c q x", 'deny'],
  ["vim -es -c 'wq .claude/settings.local.json' x", 'deny'],
  ["vim -es -c 'x .claude/settings.json' y", 'deny'],
  ["vim -es -c 'sav! .claude/settings.json' -c q x", 'deny'],
  ["vim -es -c 'up .claude/settings.json' -c q x", 'deny'],
  ["vim -es -c 'update .claude/hooks/guard-files.mjs' -c q x", 'deny'],
  ["vim -es -c 'silent! write ++enc=utf-8 .claude/settings.json' -c q x", 'deny'],
  ["vim -es -c 'keepalt sav .claude/settings.json' -c q x", 'deny'],
  ["vim -es --cmd 'w .claude/settings.json' x", 'deny'],
  ["vim -es -c 'w pnpm-lock.yaml' -c q x", 'deny'],
  ["vim -es -c 'w ~/.claude/settings.json' -c q x", 'deny'],
  ["vim -es -c 'w $HOME/.claude/settings.json' -c q x", 'deny'],
  ["vim -es -c 'g/./w >> .claude/settings.json' -c q x", 'deny'],
  ["vim -es -c 'bufdo w .claude/settings.json' -c q x", 'deny'],
  ["vim -es -c 'set nomore | w .claude/settings.json | q' x", 'deny'],
  ["vim -es -c 'w .claude/se*' -c q x", 'deny'],
  // `:cd` muda a base dos caminhos relativos seguintes (e dos arquivos do --cmd).
  ["vim -es -c 'cd .claude' -c 'w settings.json' -c q x", 'deny'],
  ["vim -es -c 'lcd .claude/hooks' -c 'w guard-bash.mjs' -c q x", 'deny'],
  ["vim -es --cmd 'cd .claude' -c '%d' -c x settings.json", 'deny'],
  // `:file` renomeia o buffer e o `:w` seguinte grava no nome novo; `:redir >` grava mensagens.
  ["vim -es -c 'file .claude/settings.json' -c 'w!' -c q x", 'deny'],
  ["vim -es -c 'redir! > .claude/settings.json' -c 'echo 1' -c 'redir END' -c q", 'deny'],
  ["vim -es -c 'mksession! .claude/hooks/x.vim' -c q", 'deny'],
  // Arquivo aberto com `:e`/`:sp`/`:tabe` vira o buffer que `:w`/`:x` gravam.
  ["vim -es -c 'e .claude/settings.json' -c '%d' -c x", 'deny'],
  ["vim -es -c 'tabe .claude/hooks/guard-bash.mjs' -c '%d' -c wq", 'deny'],
  // Configuração de hooks git/MCP: mesmo nível dos outros vetores (confirmação).
  ["vim -es -c 'w .mcp.json' -c q x", 'ask'],
  ["vim -es -c 'w lefthook-local.yml' -c q x", 'ask'],
  // Nome que só o vim resolve (`%`, `#`, crase, variável): pede confirmação.
  ["vim -es -c 'sav %:h/settings.json' .claude/x.txt", 'ask'],
  ["vim -es -c 'w `echo x`' -c q y", 'ask'],
  ["vim -es -c 'w $DESTINO' -c q y", 'ask'],
  // `:w!` grava (força); só `:w !cmd`, com espaço, chama o shell.
  ["vim -c 'w! /tmp/notas.txt' -c q x", 'none'],
  ["vim -es -c 'w !cat .env' x", 'deny'],
  ["vim -es -c 'wr !cat .env' x", 'deny'],
  ["vim -es -c 'w! !cat .env' x", 'deny'],
  ["vim -es -c 'w /tmp/saida.txt' -c q README.md", 'none'],
  ["vim -es -c 'wq' notas.txt", 'none'],
  ["vim -es -c 'sav /tmp/copia.txt' -c q README.md", 'none'],
  ["vim -es -c 'cd /tmp' -c 'w saida.txt' -c q README.md", 'none'],
  ["vim -es -c 'g/TODO/d' -c wq notas.txt", 'none'],
  ["vim -es -c 'set ff=unix' -c wq notas.txt", 'none'],
]);

table('vim/ex: comando Ex que lê arquivo de segredo', [
  ["vim -es -c 'e .env' -c 'w /tmp/x' -c q", 'deny'],
  ["vim -es -c 'r .env' -c 'w /tmp/x' -c q x", 'deny'],
  ["vim -es -c '0read apps/web/.env.local' -c 'w /tmp/x' -c q x", 'deny'],
  ["vim -es -c 'sp apps/web/.env.local' -c 'w /tmp/x' -c qa", 'deny'],
  ["vim -es -c 'tabe ~/.ssh/id_rsa' -c 'w /tmp/x' -c qa", 'deny'],
  ["vim -es -c 'view .env.production' -c 'w /tmp/x' -c q", 'deny'],
  ["vim -es '+e .env' '+w /tmp/x' +q", 'deny'],
  ["vim -es -c 'cd apps/web' -c 'e .env.local' -c 'w /tmp/x' -c q", 'deny'],
  // `:source` de .env imprime as linhas nas mensagens de erro.
  ["vim -es -c 'so .env' -c q", 'deny'],
  ["vim -es -c 'e `cat .env`' -c q", 'deny'],
  ["vim -es -c 'r .env.example' -c 'w /tmp/x' -c q x", 'none'],
  ["vim -es -c 'e README.md' -c '%p' -c 'q!'", 'none'],
]);

table('vim/ex: Vimscript e scripts que o guarda não lê', [
  ['vim -es -c \'echo system("cat .env")\' -c q', 'deny'],
  ['vim -es -c \'let x = system("git push --force origin main")\' -c q', 'deny'],
  // biome-ignore lint/security/noSecrets: comando de exemplo, não um segredo
  ['vim -es -c \'call writefile(["{}"], ".claude/settings.json")\' -c q', 'deny'],
  ['vim -es -c \'echo readfile(".env")\' -c q', 'deny'],
  ['vim -es -c \'echo system("ls")\' -c q', 'ask'],
  ["vim -es -c 'so /tmp/x.vim' -c q", 'ask'],
  ["vim -es -c 'luafile /tmp/x.lua' -c q", 'ask'],
  ["vim -es -c 'pydo return line' -c q x", 'ask'],
  ['vim -es -S /tmp/x.vim', 'ask'],
  ['vim -u /tmp/x.vim -es -c q', 'ask'],
  ['vim -S .env', 'deny'],
  ["vim -u NONE -es -c 'w /tmp/x' -c q y", 'none'],
  ["vim -u NORC -es -c '%s/a/b/g' -c wq notas.txt", 'none'],
]);

table('cp/mv/install/ln com pasta de destino: destino/basename(origem)', [
  ['cp settings.json .claude/', 'deny'],
  ['cp settings.json .claude', 'deny'],
  ['cp /tmp/x/settings.local.json .claude/', 'deny'],
  ['mv -t .claude settings.json', 'deny'],
  ['install -t .claude settings.json', 'deny'],
  ['install -m 644 -t .claude /tmp/settings.json', 'deny'],
  ['mv /tmp/guard-bash.mjs .claude/hooks/', 'deny'],
  ['cp -r /tmp/x/hooks .claude/', 'deny'],
  ['cp -r /tmp/x/hooks/ .claude', 'deny'],
  ['cp /tmp/a.json /tmp/settings.json .claude/', 'deny'],
  ['cp --target-directory .claude /tmp/settings.json', 'deny'],
  ['ln -s /tmp/settings.json .claude/', 'deny'],
  ['cd .claude && ln -s /tmp/settings.json', 'deny'],
  ['cp /tmp/settings.json ~/.claude/', 'deny'],
  ['cp /tmp/pnpm-lock.yaml ./', 'deny'],
  ['cp /tmp/pnpm-lock.yaml .', 'deny'],
  // Opção longa com valor separado não pode virar o destino.
  ['cp x .claude/settings.json --suffix .bak', 'deny'],
  ['cp settings.json .claude/ --suffix .bak', 'deny'],
  ['install --mode 644 /tmp/settings.json .claude/', 'deny'],
  // Pasta comum de .claude: continua pedindo confirmação.
  ['cp -r /tmp/x/skills .claude/', 'ask'],
  ['cp /tmp/notas.md .claude/', 'ask'],
  ['cp /tmp/.mcp.json ./', 'ask'],
  // Controles.
  ['cp README.md /tmp/', 'none'],
  ['cp src/index.ts /tmp/out.ts', 'none'],
  ['cp -T /tmp/x/settings.json /tmp/dir', 'none'],
  ['cp pnpm-lock.yaml pnpm-lock.yaml.bak', 'none'],
  ['mv /tmp/a.txt /tmp/b.txt', 'none'],
  ['install -m 755 /tmp/x /tmp/y', 'none'],
  ['cp -r /tmp/x/hooks /tmp/backup/', 'none'],
]);

table('patch: o alvo está no diff, então sempre pede confirmação (como git apply)', [
  ['patch -p1 < x.diff', 'ask'],
  ['patch -p1 -i /tmp/x.diff', 'ask'],
  ['patch -Np1 --input=/tmp/x.diff', 'ask'],
  ['patch -d .claude < x.diff', 'ask'],
  ['patch -d apps/web -p1 < x.diff', 'ask'],
  ['cd .claude && patch -p1 < x.diff', 'ask'],
  ['git diff | patch -p1 -R', 'ask'],
  // Pasta da configuração protegida (todo arquivo do diff cai nela): nega.
  ['patch -d .claude/hooks -p1 < x.diff', 'deny'],
  ['patch --directory=.claude/hooks < x.diff', 'deny'],
  ['patch --dir .claude/hooks/lib < x.diff', 'deny'],
  ['patch -d.claude/hooks < x.diff', 'deny'],
  ['patch -Np1d .claude/hooks < x.diff', 'deny'],
  ['cd .claude/hooks && patch < x.diff', 'deny'],
  ['cd .claude && patch -d hooks < x.diff', 'deny'],
  // Arquivo nomeado na linha de comando, saída (-o) e rejeitos (-r).
  ['patch .claude/settings.json < /tmp/p.diff', 'deny'],
  ['cd .claude && patch settings.json < /tmp/p.diff', 'deny'],
  ['patch -d .claude settings.json /tmp/p.diff', 'deny'],
  ['patch -o .claude/settings.json README.md < x.diff', 'deny'],
  ['patch --output .claude/hooks/x.mjs README.md < x.diff', 'deny'],
  ['patch --reject-file=.claude/settings.json -p1 < x.diff', 'deny'],
  ['patch -r .claude/hooks/x.rej -p1 < x.diff', 'deny'],
  ['patch pnpm-lock.yaml < x.diff', 'deny'],
  ['patch -i .env', 'deny'],
  // Saída para outro lugar ou simulação: o diff não toca a pasta protegida.
  ['patch -d .claude/hooks -o /tmp/out.mjs guard-bash.mjs < x.diff', 'ask'],
  ['patch --dry-run -p1 < x.diff', 'none'],
  ['patch --version', 'none'],
]);
