// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeAnsiC,
  expandBraces,
  findBalanced,
  findSubstitutions,
  parseShell,
} from '../lib/shell.mjs';

/** @param {string} script */
function words(script) {
  return parseShell(script).commands.map((c) => c.words);
}

describe('parseShell: palavras e aspas', () => {
  it('remove aspas vazias que escondem o nome do comando', () => {
    assert.deepEqual(words("r''m -rf /"), [['rm', '-rf', '/']]);
    assert.deepEqual(words('"r"m -rf /'), [['rm', '-rf', '/']]);
    assert.deepEqual(words('\\rm -rf /'), [['rm', '-rf', '/']]);
  });

  it('decodifica $"..." e $\'...\' (ANSI-C)', () => {
    assert.deepEqual(words("$'\\x72\\x6d' -rf /"), [['rm', '-rf', '/']]);
    assert.deepEqual(words("$'\\162\\155' x"), [['rm', 'x']]);
  });

  it('expande listas de chaves fora de aspas e preserva dentro', () => {
    assert.deepEqual(words('{rm,-rf,/}'), [['rm', '-rf', '/']]);
    assert.deepEqual(words('echo "{a,b}"'), [['echo', '{a,b}']]);
    // Sequências também expandem (bash 5.2: `echo {1..3}` imprime `1 2 3`); a forma inválida
    // e a com aspas ficam literais.
    assert.deepEqual(words('echo {1..3}'), [['echo', '1', '2', '3']]);
    assert.deepEqual(words('echo {a..zz} "{1..3}"'), [['echo', '{a..zz}', '{1..3}']]);
  });

  it('marca palavras dinâmicas', () => {
    const [cmd] = parseShell('echo "$HOME" plain $(id) `date`').commands;
    assert.deepEqual(cmd?.dynamic, [false, true, false, true, true]);
    assert.deepEqual(cmd?.substitutions, ['id', 'date']);
  });

  it('ignora comentários', () => {
    assert.deepEqual(words('echo oi # rm -rf /'), [['echo', 'oi']]);
  });

  it('reporta aspas sem fechamento como erro', () => {
    assert.deepEqual(parseShell('echo "abc').errors, ['aspas duplas sem fechamento']);
    assert.ok(parseShell("echo 'abc").errors.length > 0);
    assert.ok(parseShell('echo $(abc').errors.length > 0);
  });
});

describe('parseShell: sequência {x..y[..passo]} como o bash 5.2', () => {
  // Cada valor esperado é a saída de `bash -c 'echo <expr>'` (GNU bash 5.2.21).
  const cases = /** @type {Array<[string, string[]]>} */ ([
    ['{1..3}', ['1', '2', '3']],
    ['{3..1}', ['3', '2', '1']],
    ['{01..3}', ['01', '02', '03']],
    ['{1..003}', ['001', '002', '003']],
    ['{-1..2}', ['-1', '0', '1', '2']],
    ['{-01..2}', ['-01', '000', '001', '002']],
    ['{-0..2}', ['0', '1', '2']],
    ['{+01..3}', ['1', '2', '3']],
    ['{1..10..3}', ['1', '4', '7', '10']],
    ['{1..10..-3}', ['1', '4', '7', '10']],
    ['{10..1..3}', ['10', '7', '4', '1']],
    ['{1..3..0}', ['1', '2', '3']],
    ['{a..e..2}', ['a', 'c', 'e']],
    ['{e..a}', ['e', 'd', 'c', 'b', 'a']],
    ['{Z..b}', ['Z', '[', '\\', ']', '^', '_', '`', 'a', 'b']],
    ['x{a..c}y', ['xay', 'xby', 'xcy']],
    ['{a..b}{1..2}', ['a1', 'a2', 'b1', 'b2']],
    ['{{1..2}}', ['{1}', '{2}']],
    ['{x,{1..2}}', ['x', '1', '2']],
    ['{a..c,x}', ['a..c', 'x']],
    ['.e{n..n}v', ['.env']],
    // Formas que o bash deixa literais.
    ['{a..zz}', ['{a..zz}']],
    ['{1..a}', ['{1..a}']],
    ['{1...3}', ['{1...3}']],
    ['{1..3..}', ['{1..3..}']],
    ["{1'..'3}", ['{1..3}']],
  ]);
  for (const [expr, expected] of cases) {
    it(`echo ${expr}`, () => {
      assert.deepEqual(words(`echo ${expr}`), [['echo', ...expected]]);
    });
  }

  it('acima do teto: erro de análise (o chamador pede confirmação) e a palavra original preservada', () => {
    const seq = parseShell('echo {1..100}');
    assert.ok(
      seq.errors.some((e) => e.includes('chaves')),
      seq.errors.join(' | '),
    );
    assert.equal(seq.commands[0]?.words.at(-1), '{1..100}');
    const product = parseShell(`echo .claude/${'{a,b}'.repeat(7)}`);
    assert.ok(
      product.errors.some((e) => e.includes('chaves')),
      product.errors.join(' | '),
    );
    assert.equal(product.commands[0]?.words.at(-1), `.claude/${'{a,b}'.repeat(7)}`);
    assert.ok((product.commands[0]?.words.length ?? 0) <= 66);
  });

  it('acima do teto, as alternativas que sobraram na pilha ainda viram palavras', () => {
    for (const script of [
      'cat {{1..64},.env}',
      'cat {x{,}{,}{,}{,}{,}{,}{,},.env}',
      'cat {{1..64},.e{n,x}v}',
      'cat {{1..64},{.env,x}}',
    ]) {
      const parsed = parseShell(script);
      assert.ok(
        parsed.errors.some((e) => e.includes('chaves')),
        `${script}: ${parsed.errors.join(' | ')}`,
      );
      assert.ok(parsed.commands[0]?.words.includes('.env'), `${script}: sem .env`);
    }
  });

  it('dentro do teto não há erro', () => {
    assert.deepEqual(parseShell('echo {1..64}').errors, []);
    assert.equal(parseShell('echo {1..64}').commands[0]?.words.length, 65);
  });
});

describe('parseShell: operadores, pipelines e redirecionamentos', () => {
  it('separa comandos e marca pipes', () => {
    const { commands } = parseShell('a | b && c; d &');
    assert.deepEqual(
      commands.map((c) => [c.words[0], c.pipedIn, c.pipedOut, c.pipeline]),
      [
        ['a', false, true, 0],
        ['b', true, false, 0],
        ['c', false, false, 1],
        ['d', false, false, 2],
      ],
    );
  });

  it('coleta redirecionamentos com descritor', () => {
    const [cmd] = parseShell('cat <<< "$X" > out 2>&1').commands;
    assert.deepEqual(cmd?.redirects, [
      { op: '>', target: 'out', dynamic: false },
      { op: '>&', target: '1', dynamic: false, fd: '2' },
    ]);
    assert.deepEqual(cmd?.hereStrings, ['$X']);
  });

  it('captura heredocs com e sem expansão', () => {
    const [cmd] = parseShell("psql <<'SQL'\nDROP TABLE x;\nSQL").commands;
    assert.deepEqual(cmd?.heredocs, [{ delimiter: 'SQL', expand: false, body: 'DROP TABLE x;' }]);
    const [cmd2] = parseShell('cat <<EOF\n$HOME\nEOF').commands;
    assert.equal(cmd2?.heredocs[0]?.expand, true);
    const [cmd3] = parseShell('cat <<-EOF\n\tx\n\tEOF').commands;
    assert.deepEqual(cmd3?.heredocs, [{ delimiter: 'EOF', expand: true, body: 'x' }]);
  });

  it('heredoc com apóstrofo dentro de $(...) não quebra a análise', () => {
    const script = "git commit -m \"$(cat <<'EOF'\nfeat: it's ok\nEOF\n)\"";
    const { commands, errors } = parseShell(script);
    assert.deepEqual(errors, []);
    assert.deepEqual(commands[0]?.words.slice(0, 3), ['git', 'commit', '-m']);
    assert.deepEqual(commands[0]?.substitutions, ["cat <<'EOF'\nfeat: it's ok\nEOF\n"]);
  });

  it('substituição de processo vira /dev/fd e o script é coletado', () => {
    const [cmd] = parseShell('diff <(cat a) <(cat b)').commands;
    assert.deepEqual(cmd?.words, ['diff', '/dev/fd/63', '/dev/fd/63']);
    assert.deepEqual(cmd?.processSubstitutions, ['cat a', 'cat b']);
  });

  it('atribuições ficam nas palavras (o chamador decide)', () => {
    assert.deepEqual(words('x=1 y=$(id) cmd'), [['x=1', 'y=$(id)', 'cmd']]);
  });
});

describe('utilitários do lexer', () => {
  it('decodeAnsiC', () => {
    assert.equal(decodeAnsiC('\\x72\\x6d\\n\\t\\u00e9'), 'rm\n\té');
  });

  it('expandBraces respeita a máscara de literais', () => {
    assert.deepEqual(expandBraces('{a,b}', Array(5).fill(false)), ['a', 'b']);
    assert.deepEqual(expandBraces('{a,b}', Array(5).fill(true)), ['{a,b}']);
  });

  it('expandBraces limita a explosão combinatória', () => {
    const value = '{a,b}'.repeat(12);
    const out = expandBraces(value, Array(value.length).fill(false));
    assert.ok(out.length <= 64, `gerou ${out.length}`);
  });

  it('expandBraces expande sequência e respeita a máscara de literais', () => {
    assert.deepEqual(expandBraces('{1..3}', Array(6).fill(false)), ['1', '2', '3']);
    assert.deepEqual(expandBraces('{1..3}', Array(6).fill(true)), ['{1..3}']);
  });

  it('findBalanced respeita aspas e aninhamento', () => {
    assert.equal(findBalanced('$(a (b) ")" c) x', 2, '(', ')'), 13);
    assert.equal(findBalanced('$(a', 2, '(', ')'), -1);
  });

  it('findSubstitutions encontra $(...) e crases, inclusive aninhadas', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: sintaxe de shell
    assert.deepEqual(findSubstitutions('a $(b) `c` ${d}').subs, ['b', 'c']);
    assert.ok(findSubstitutions('x $(echo $(id))').subs.includes('echo $(id)'));
  });
});
