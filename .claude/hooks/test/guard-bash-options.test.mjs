// @ts-check
/**
 * Opções curtas agrupadas em interpretadores (`python3 -Ic`, `node -pe`, `bash -c -e`) e
 * opções longas abreviadas do git (`--forc`, `--mi`, `--delet`). Achados da revisão
 * automática do commit 27291ce: cada caso `deny`/`ask` passava como `none` antes da correção;
 * os casos `none` protegem o fluxo normal contra falso positivo.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateBashCommand } from '../lib/bash-policy.mjs';
import { parseInterpreterArgs, resolveGitLongOption } from '../lib/cli-options.mjs';
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

table('python: opções agrupadas, anexadas e com valor antes do -c', [
  ["python3 -Ic 'import os; print(os.environ)'", 'deny'],
  ["python3 -Ec 'import os; print(os.environ)'", 'deny'],
  ["python3 -IEsc 'import os; print(os.environ)'", 'deny'],
  ["python3 '-cimport os; print(os.environ)'", 'deny'],
  ["python3 -X dev -c 'import os; print(os.environ)'", 'deny'],
  ["python3 -W ignore -c 'import os; print(os.environ)'", 'deny'],
  ["python3 -bc 'import os; print(os.environ)'", 'deny'],
  ['python3 -Sc "print(open(\'.env\').read())"', 'deny'],
  ["python3.13 -c 'import os; print(os.environ)'", 'deny'],
  ["/usr/bin/python3.12 -Ic 'import os; print(os.environ)'", 'deny'],
  ["pypy3 -c 'import os; print(os.environ)'", 'deny'],
  ["python3 -Zc 'print(1)'", 'ask'],
  // Código anexado à opção também pode ser dinâmico.
  ['python3 "-c$C"', 'ask'],
  ['node "--eval=$C"', 'ask'],
  ['php "-r$C"', 'ask'],
  ["python3 -Ic 'print(1)'", 'none'],
  ["python3 -I -c 'print(1)'", 'none'],
  ["python3 -X utf8 -c 'print(1)'", 'none'],
  ["python3 -OO -c 'print(1)' -x arg", 'none'],
  ['python3 -u scripts/x.py', 'none'],
  ['python3 -m pytest -q', 'none'],
  ['python3 -W ignore -m json.tool package.json', 'none'],
]);

table('node, bun e ts-node: -pe e opções com valor antes do código', [
  ["node -pe 'process.env'", 'deny'],
  ["node -pe 'process.env.DATABASE_URL'", 'deny'],
  // biome-ignore lint/security/noSecrets: comando de exemplo, não um segredo
  ['node -pe \'require("fs").readFileSync(".env","utf8")\'', 'deny'],
  ["node -r ./x.cjs -e 'console.log(process.env)'", 'deny'],
  ["node --require ./x.cjs -e 'console.log(process.env)'", 'deny'],
  ["node --input-type module -e 'console.log(process.env)'", 'deny'],
  ["node -C dev -p 'process.env'", 'deny'],
  ["bun -pe 'process.env'", 'deny'],
  ["bun '-econsole.log(process.env)'", 'deny'],
  ["ts-node -pe 'process.env'", 'deny'],
  ["tsx -pe 'process.env'", 'deny'],
  ["node -pre 'x' 'process.env'", 'ask'],
  // Código inline também chega por URL data: em opções que carregam módulo.
  ["node --import 'data:text/javascript,console.log(process.env)' -e 1", 'deny'],
  ["node '--import=data:text/javascript,console.log(process.env)' x.js", 'deny'],
  ["node -r 'data:text/javascript,console.log(process.env)' x.js", 'deny'],
  // biome-ignore lint/security/noSecrets: base64 de "console.log(process.env)", não um segredo
  ["node --import='data:text/javascript;base64,Y29uc29sZS5sb2cocHJvY2Vzcy5lbnYp' -e 1", 'deny'],
  ["node --experimental-loader 'data:text/javascript,console.log(process.env)' x.js", 'deny'],
  ["NODE_OPTIONS='--import=data:text/javascript,console.log(process.env)' pnpm test", 'deny'],
  ["node --import 'data:text/javascript;base64,%%%' x.js", 'ask'],
  ['node --import tsx x.ts', 'none'],
  ["NODE_OPTIONS='--max-old-space-size=4096' pnpm build", 'none'],
  ["node -pe '1 + 1'", 'none'],
  ["node -p 'process.versions.node'", 'none'],
  ['node --test .claude/hooks/test', 'none'],
  ['node -r ./setup.cjs dist/index.js', 'none'],
  ['node --enable-source-maps dist/index.js --port 3000', 'none'],
]);

table('perl e ruby: agrupamentos com valor e código anexado', [
  ["perl -lne 'print %ENV'", 'deny'],
  ["perl -I lib -e 'print %ENV'", 'deny'],
  ["perl -0777 -ne 'print %ENV'", 'deny'],
  ["perl -l0e 'print %ENV'", 'deny'],
  ["perl '-eprint %ENV'", 'deny'],
  ["perl -Mstrict -wle 'print %ENV'", 'deny'],
  ["ruby -ne 'p ENV'", 'deny'],
  ["ruby -I lib -e 'p ENV'", 'deny'],
  ["ruby -r json -e 'p ENV'", 'deny'],
  ["ruby -wle 'p ENV'", 'deny'],
  ["ruby '-ep ENV'", 'deny'],
  ["ruby -C /tmp -e 'p ENV'", 'deny'],
  ["perl -Ye 'print 1'", 'ask'],
  ["ruby -Ze 'p 1'", 'ask'],
  ["perl -lne 'print $1 if /v(\\d+)/' README.md", 'none'],
  ["perl -0777 -pe 's/a/b/' README.md", 'none'],
  ["perl -Mstrict -wle 'print 1'", 'none'],
  // biome-ignore lint/security/noSecrets: comando de exemplo, não um segredo
  ['ruby -rjson -e \'p JSON.parse("{}")\'', 'none'],
  ["ruby -wle 'puts 1'", 'none'],
]);

table('php: -r agrupado, -B/-R/-E, --run e phpinfo', [
  ["php -nr 'print_r($_ENV);'", 'deny'],
  ["php '-rprint_r($_ENV);'", 'deny'],
  ["php -d display_errors=1 -r 'print_r(getenv());'", 'deny'],
  ["php -R 'print_r(getenv());'", 'deny'],
  ["php -B 'print_r(getenv());'", 'deny'],
  ["php -E 'print_r(getenv());'", 'deny'],
  ["php --run 'print_r(getenv());'", 'deny'],
  ["php --run='print_r(getenv());'", 'deny'],
  ["php --process-begin 'print_r(getenv());'", 'deny'],
  ['php -i', 'deny'],
  ['php -ni', 'deny'],
  ['php --info', 'deny'],
  ["php -Yr 'echo 1;'", 'ask'],
  ["php -r 'echo PHP_VERSION;'", 'none'],
  ["php -n -r 'echo 1;'", 'none'],
  ['php -v', 'none'],
  ['php -l src/x.php', 'none'],
]);

table('shells: opções depois do -c e -o com valor no mesmo agrupamento', [
  ["bash -c -e 'cat .env'", 'deny'],
  ["bash -c -x 'rm -rf ~'", 'deny'],
  ["sh -c -- 'cat .env'", 'deny'],
  ["bash -co pipefail 'cat .env'", 'deny'],
  ["bash -eo pipefail -c 'cat .env'", 'deny'],
  ["bash -o errexit -o pipefail -c 'cat .env'", 'deny'],
  ["bash --norc --noprofile -c 'cat .env'", 'deny'],
  ["bash -xc 'cat .env'", 'deny'],
  ["sh -ec 'cat .env'", 'deny'],
  ["zsh -c -x 'cat .env'", 'deny'],
  ["fish -c 'cat .env'", 'deny'],
  ["fish --command 'cat .env'", 'deny'],
  ["fish --command='cat .env'", 'deny'],
  ["fish -C 'cat .env'", 'deny'],
  ["fish --init-command='rm -rf ~'", 'deny'],
  ["bash -c -e 'echo ok'", 'none'],
  ["bash -eo pipefail -c 'echo ok'", 'none'],
  ['bash -x scripts/with-local-postgres.sh pnpm test:db', 'none'],
  ['bash -n scripts/with-local-postgres.sh', 'none'],
  ["fish -c 'echo ok'", 'none'],
]);

table('git push: opções longas abreviadas', [
  ['git push --forc origin claude/x', 'deny'],
  ['git push --for origin claude/x', 'deny'],
  ['git push --fo origin claude/x', 'deny'],
  ['git push --mirr origin', 'deny'],
  ['git push --mi origin', 'deny'],
  ['git push --delet origin main', 'deny'],
  ['git push --de origin main', 'deny'],
  ["git push --receive='rm -rf ~' origin claude/x", 'deny'],
  ["git push --ex='cat .env' origin claude/x", 'deny'],
  ['git push --no-verif origin claude/x', 'deny'],
  ['git push -4f origin claude/x', 'deny'],
  ['git push -f6 origin claude/x', 'deny'],
  ['git push --force-w origin claude/x', 'ask'],
  ['git push --force-with-l=claude/x origin claude/x', 'ask'],
  ['git push --force-i origin claude/x', 'ask'],
  ['git push --al origin', 'ask'],
  ['git push --branche origin', 'ask'],
  ['git push --bra origin', 'ask'],
  ['git push --delet origin claude/x', 'ask'],
  ['git push --receive=meu-receive-pack origin claude/x', 'ask'],
  ['git push --fol origin claude/x', 'none'],
  ['git push --follow-tags origin claude/x', 'none'],
  ['git push --set-up origin claude/x', 'none'],
  ['git push --no-force origin claude/x', 'none'],
  ['git push --no-forc origin claude/x', 'none'],
  ['git push --porc origin claude/x', 'none'],
  ['git push --dry origin claude/x', 'none'],
  ['git push --rep=origin claude/x', 'none'],
  ['git push -4 -u origin claude/x', 'none'],
  // Opção que a tabela (git 2.43) não conhece: um git mais novo pode resolvê-la para algo
  // perigoso; no push, pede confirmação.
  ['git push --force-novidade origin claude/x', 'ask'],
  ['git push --opcao-inexistente origin claude/x', 'ask'],
]);

table('git commit/merge/rebase e subcomandos destrutivos: abreviações', [
  ['git commit --no-verif -m x', 'deny'],
  ['git merge --no-verif feature', 'deny'],
  ['git merge --no-verify feature', 'deny'],
  ['git rebase --no-ver main', 'deny'],
  ['git reset --har HEAD~1', 'ask'],
  ['git clean --forc -d', 'ask'],
  ['git checkout --forc main', 'ask'],
  ['git switch --discard main', 'ask'],
  ['git branch --delet --forc claude/velha', 'ask'],
  ['git add --forc .env.example', 'ask'],
  ['git merge --no-verify-s feature', 'none'],
  ['git commit --amen --no-edit', 'none'],
  ['git rebase --onto main HEAD~2', 'none'],
  ['git reset --soft HEAD~1', 'none'],
  ['git branch --show-current', 'none'],
]);

describe('resolveGitLongOption (prefixo único, como o parse-options do git)', () => {
  it('resolve abreviação única para o nome completo e preserva o valor', () => {
    assert.deepEqual(resolveGitLongOption('push', '--mi'), { name: '--mirror', value: null });
    assert.deepEqual(resolveGitLongOption('push', '--force-with-l=a:b'), {
      name: '--force-with-lease',
      value: 'a:b',
    });
    assert.deepEqual(resolveGitLongOption('push', '--force'), { name: '--force', value: null });
  });

  it('marca abreviação ambígua com todos os candidatos', () => {
    const r = resolveGitLongOption('push', '--forc');
    assert.ok(r && 'ambiguous' in r);
    assert.ok(r.ambiguous.includes('--force'));
    assert.ok(r.ambiguous.includes('--force-with-lease'));
  });

  it('devolve null para opção desconhecida ou subcomando sem tabela', () => {
    assert.equal(resolveGitLongOption('push', '--nada-disso'), null);
    assert.equal(resolveGitLongOption('status', '--short'), null);
  });
});

describe('parseInterpreterArgs', () => {
  it('extrai o código de agrupamentos e de opções com valor', () => {
    assert.deepEqual(
      parseInterpreterArgs('python3', ['-Ic', 'print(1)']).inline.map((c) => c.code),
      ['print(1)'],
    );
    assert.deepEqual(
      parseInterpreterArgs('perl', ['-I', 'lib', '-lne', 'print']).inline.map((c) => c.code),
      ['print'],
    );
    assert.deepEqual(
      parseInterpreterArgs('ruby', ['-ep 1']).inline.map((c) => c.code),
      ['p 1'],
    );
  });

  it('reconhece o script e para nele', () => {
    const r = parseInterpreterArgs('python3', ['-u', 'x.py', '-c', 'nao-e-codigo']);
    assert.equal(r.script, true);
    assert.deepEqual(r.inline, []);
  });

  it('lista agrupamentos desconhecidos', () => {
    assert.deepEqual(parseInterpreterArgs('python3', ['-Zc', 'print(1)']).unknown, ['-Zc']);
  });
});
