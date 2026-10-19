// @ts-check
/**
 * Lacunas dos guardas apontadas pela revisão do plugin security-guidance (2026-10-19) e as
 * variantes achadas ao corrigi-las. Cada caso `deny` ou `ask` daqui passava como `none` (ou
 * travava a análise) antes da correção; os casos `none` protegem o fluxo normal contra falso
 * positivo.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateBashCommand } from '../lib/bash-policy.mjs';
import { PROJECT_ROOT } from '../test-support/helpers.mjs';

/**
 * @param {Partial<import('../lib/bash-policy.mjs').PolicyContext>} [overrides]
 * @returns {import('../lib/bash-policy.mjs').PolicyContext}
 */
function ctx(overrides = {}) {
  return {
    cwd: PROJECT_ROOT,
    projectDir: PROJECT_ROOT,
    currentBranch: () => 'claude/feature-x',
    existsOnDefaultBranch: () => ({ exists: false, ref: null, rel: null }),
    ...overrides,
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

// O bash 5.2 expande `{x..y[..passo]}` antes de executar: `cat .e{n..n}v` lê o `.env`.
table('sequência de chaves {x..y} e teto da expansão (fail-closed)', [
  ['cat .e{n..n}v', 'deny'],
  ['git push origin ma{i..i}n', 'deny'],
  ['git push origin {l..m}ain', 'deny'],
  ['tee .cl{a..a}ude/settings.json < x', 'deny'],
  ['cp x .claude/hook{s..s}/guard-bash.mjs', 'deny'],
  ['tee .claude/hook{r..t}/guard-bash.mjs < x', 'deny'],
  // Produto acima do teto: a combinação perigosa ficava fora das 64 primeiras.
  ['tee .claude/{x,settings.json}{,a,b,c,d,e,f,g,h}{,a,b,c,d,e,f,g,h} < x', 'deny'],
  // A alternativa perigosa depois de 64 palavras geradas antes dela não pode sumir da análise
  // (a expansão em profundidade parava no teto e descartava o resto da pilha).
  ['cat {{1..64},.env}', 'deny'],
  ['cat {a{1..64},.env}', 'deny'],
  ['cat {x{,}{,}{,}{,}{,}{,}{,},.env}', 'deny'],
  ['cat {{1..64},/proc/self/environ}', 'deny'],
  ['cat {{1..64},.e{n,x}v}', 'deny'],
  ['cat {{1..64},{.env,x}}', 'deny'],
  ['git push origin {{1..64},main}', 'deny'],
  ['git push origin {x{,}{,}{,}{,}{,}{,}{,},main}', 'deny'],
  ['tee {{1..64},.claude/settings.json} < x', 'deny'],
  // Acima do teto e sob .claude/: nega; fora de .claude/: pede confirmação.
  ['tee .claude/{1..100}.txt < x', 'deny'],
  ['tee docs/{1..100}.txt < x', 'ask'],
  ['echo {1..100}', 'ask'],
  ['echo {1..3}', 'none'],
  ['for i in {1..10}; do echo "$i"; done', 'none'],
  ['touch src/{a..c}.ts', 'none'],
  ['mkdir -p tmp/{01..12}', 'none'],
]);

table('glob que casa o diretório protegido (não só os arquivos dele)', [
  ['mv .claude/h* /tmp/', 'deny'],
  ['rm -rf .claude/h*', 'deny'],
  ['mv .claude/m* /tmp/', 'ask'],
  ['mv .git/h* /tmp/', 'ask'],
  ['mv .hus* /tmp/', 'ask'],
  ['ls .claude/h*', 'none'],
  ['mv src/h* /tmp/', 'none'],
]);

// `-t`/`--track` sem `-b` cria a branch local com o nome da remota; criar a partir de
// `origin/main` (com ou sem `--track`) faz de main o upstream, e `git push` sem refspec segue o
// upstream quando push.default=upstream. Comportamento conferido no git 2.43.
table('push depois de checkout/switch com --track ou a partir de ref remota', [
  ['git checkout -t origin/main && git push', 'deny'],
  ['git checkout --track origin/main && git push', 'deny'],
  ['git checkout --tr origin/main && git push', 'deny'],
  ['git checkout --track=direct origin/main && git push', 'deny'],
  ['git checkout -tdirect origin/main && git push', 'deny'],
  ['git checkout -t origin/main && git push origin HEAD', 'deny'],
  ['git checkout -q -t upstream/master && git push', 'deny'],
  ['git checkout -t refs/remotes/origin/main && git push', 'deny'],
  ['git switch -t origin/main && git push', 'deny'],
  ['git switch --track origin/main && git push', 'deny'],
  ['git switch -c x --track origin/main && git push', 'deny'],
  ['git switch -cx -t origin/main && git push', 'deny'],
  ['git switch -c x origin/main && git push', 'deny'],
  ['git switch --cre=x origin/main && git push origin', 'deny'],
  ['git checkout -b x origin/main && git push', 'deny'],
  ['git checkout -qb x origin/main && git push', 'deny'],
  ['git checkout -bx remotes/origin/main && git push', 'deny'],
  ['git switch -c x --no-track --track origin/main && git push', 'deny'],
  ['git checkout -bmain && git push', 'deny'],
  ['git checkout -qbmain && git push origin HEAD', 'deny'],
  ['git switch -qcmain && git push', 'deny'],
  ['git switch -- main && git push', 'deny'],
  ['git branch -u origin/main && git push', 'deny'],
  ['git branch --set-upstream-to=origin/main && git push', 'deny'],
  ['git branch -uorigin/main && git push', 'deny'],
  ['git switch -c x --track=inherit claude/y && git push', 'ask'],
  ['git switch -c claude/z origin/main && git push -u origin HEAD', 'none'],
  ['git switch -c claude/z origin/main && git push -u origin claude/z', 'none'],
  ['git switch --no-track -c x origin/main && git push', 'none'],
  ['git switch -c x --track origin/main --no-track && git push', 'none'],
  ['git checkout -t origin/claude/y && git push', 'none'],
  ['git checkout -b claude/y && git push', 'none'],
  ['git branch -u origin/claude/y && git push', 'none'],
  // Fluxo normal: branch nova a partir de origin/main, com push de refspec explícito.
  ['git checkout -b feat/x origin/main', 'none'],
  ['git switch -c y --track origin/claude/y', 'none'],
  ['git checkout -b feat/x origin/main && git push -u origin feat/x', 'none'],
  ['git checkout -b feat/x origin/main && git push -u origin HEAD', 'none'],
  ['git switch -c y --track origin/claude/y && git push', 'none'],
  ['git checkout main -- README.md && git push origin HEAD', 'none'],
  ['git branch -u origin/main claude/outra && git push', 'none'],
  ['git branch -u origin/main claude/feature-x && git push', 'deny'],
  ['git branch --unset-upstream && git push', 'none'],
  ['git checkout -t origin/main', 'none'],
  ['git checkout -b x "$BASE" && git push', 'ask'],
]);

// xargs (findutils 4.9) usa getopt_long com "+": letras agrupadas (`-ra`), valor anexado ou no
// argumento seguinte para a, d, E, I, L, n, P, s; valor só anexado para e, i, l; opção longa
// por prefixo único (`--arg` = `--arg-file`).
table('xargs: opções agrupadas, prefixo de opção longa e segredo como comando', [
  ['xargs -ra .env cat', 'deny'],
  ['xargs -ra.env cat', 'deny'],
  ['xargs -0ra .env.local cat', 'deny'],
  ['xargs -rta ~/.ssh/id_rsa echo', 'deny'],
  ['xargs -ra /proc/self/environ echo', 'deny'],
  ['xargs --arg=.env cat', 'deny'],
  ['xargs --arg-f .env echo', 'deny'],
  ['xargs -ia .env cat', 'deny'],
  ['echo x | xargs ./.env', 'deny'],
  ['echo x | xargs -r .env', 'deny'],
  ['./.env', 'deny'],
  ['env ./.env', 'deny'],
  ['timeout 5 ./.env.local', 'deny'],
  ['xargs -ra list.txt echo', 'none'],
  ['xargs -0 -n1 echo < list.txt', 'none'],
  ["find . -name '*.md' | xargs -r grep -l foo", 'none'],
  ['xargs -I{} -n1 echo {} < list.txt', 'none'],
  ['xargs -rl1 echo < list.txt', 'none'],
]);

describe('refspec com curingas repetidos não trava a análise (ReDoS)', () => {
  it('git push com 14 asteriscos seguidos decide em menos de 1 s', () => {
    const started = performance.now();
    const result = evaluateBashCommand(`git push origin '${'*'.repeat(14)}x'`, ctx());
    const elapsed = performance.now() - started;
    assert.equal(result.decision, 'ask');
    assert.ok(elapsed < 1000, `levou ${elapsed.toFixed(0)} ms`);
  });

  it('*? repetido e curinga com literal repetido também decidem em menos de 1 s', () => {
    for (const spec of [`${'*?'.repeat(40)}x`, `${'*a'.repeat(200)}`, `${'?*'.repeat(60)}x`]) {
      const started = performance.now();
      const result = evaluateBashCommand(`git push origin '${spec}'`, ctx());
      const elapsed = performance.now() - started;
      assert.equal(result.decision, 'ask', `${spec.slice(0, 20)}: ${result.reasons.join(' | ')}`);
      assert.ok(elapsed < 1000, `${spec.slice(0, 20)} levou ${elapsed.toFixed(0)} ms`);
    }
  });
});

// `git stash push -- <caminho>` volta o arquivo ao HEAD na árvore de trabalho: é escrita nele,
// como `git checkout -- <caminho>` e `git restore <caminho>` (negados em .claude/hooks).
table('git stash com caminho protegido', [
  ['git stash push -- .claude/hooks/lib/files-policy.mjs', 'deny'],
  ['git stash push .claude/settings.json', 'deny'],
  ['git stash -- .claude/hooks/guard-bash.mjs', 'deny'],
  ['git stash push -m wip -- .claude/hooks', 'deny'],
  ['git stash push -qm wip .claude/hooks/lib/paths.mjs', 'deny'],
  ['git stash push --mess wip .claude/settings.json', 'deny'],
  ['git stash push -q -- .git/hooks/pre-commit', 'ask'],
  ['git stash push --pathspec-from-file=list.txt', 'ask'],
  ['git stash', 'none'],
  ['git stash push -- src/index.ts', 'none'],
  ['git stash push -m "wip .claude/hooks"', 'none'],
  ['git stash push --message=.claude/hooks -- src/a.ts', 'none'],
  ['git stash pop', 'none'],
  ['git stash list', 'none'],
  ['git stash show -p stash@{0}', 'none'],
  ['git stash save "ajuste em .claude/hooks"', 'none'],
]);

describe('glob de escrita que não dá para analisar fora de .claude/', () => {
  it('pede confirmação pelo motivo certo (análise), sem citar hooks/MCP', () => {
    for (const command of [
      `echo x > src/${'a*'.repeat(600)}.ts`,
      `echo x > docs/${'a'.repeat(1100)}/[x].md`,
      'tee docs/{1..100}.txt < x',
    ]) {
      const result = evaluateBashCommand(command, ctx());
      const text = result.reasons.join(' | ');
      assert.equal(result.decision, 'ask', text.slice(0, 300));
      assert.ok(!text.includes('hooks/MCP'), text.slice(0, 300));
      assert.ok(text.includes('análise'), text.slice(0, 300));
    }
  });

  it('glob que alcança a configuração de hooks git continua com a mensagem de hooks/MCP', () => {
    const result = evaluateBashCommand('mv .git/h* /tmp/', ctx());
    assert.equal(result.decision, 'ask');
    assert.ok(result.reasons.join(' | ').includes('hooks/MCP'));
  });
});

// `?` no padrão do refspec era passado cru à expressão regular: `?*` lançava exceção
// ("Nothing to repeat") e `ma?in*` mudava de sentido. Agora é um caractere qualquer.
table('refspec curinga com ?', [
  ["git push origin '?*'", 'deny'],
  ["git push origin 'refs/heads/?ain*'", 'deny'],
  ["git push origin 'refs/heads/m?in*'", 'deny'],
  ["git push origin 'refs/heads/?laude/*'", 'ask'],
  ["git push origin 'refs/heads/claude/*'", 'ask'],
]);
