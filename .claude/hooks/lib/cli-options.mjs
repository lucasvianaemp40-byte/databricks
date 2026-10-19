// @ts-check
/**
 * Tabelas e leitores de opções de linha de comando usados pelo guard-bash.
 *
 * - Interpretadores (python, node, perl, ruby, php...) aceitam opções curtas agrupadas
 *   (`python3 -Ic`, `perl -lne`), valor anexado (`-cCODE`, `-Ilib`) ou no argumento seguinte
 *   (`-I lib`, `-X dev`, `node -r ./x`). O código inline só é achado lendo cada letra com a
 *   tabela do interpretador; letra desconhecida vira `unknown` e o chamador pede confirmação
 *   (fail-closed).
 * - Shells (`bash -c -e 'cmd'`, `bash -co pipefail 'cmd'`, `fish -C 'cmd'`).
 * - Opções longas do git: o parse-options aceita qualquer prefixo único (`--forc`, `--mi`,
 *   `--delet`). A tabela vem de `git <sub> --git-completion-helper-all` (git 2.43); `=` no
 *   fim marca opção que exige valor.
 */

/** Opções longas por subcomando do git (formas positivas e negadas). */
const GIT_LONG_OPTIONS = {
  push: `
    --verbose --quiet --repo= --all --branches --mirror --delete --tags --dry-run --porcelain
    --force --force-with-lease --force-if-includes --recurse-submodules= --thin --receive-pack=
    --exec= --set-upstream --progress --prune --no-verify --follow-tags --signed --atomic
    --push-option= --ipv4 --ipv6 --verify --no-verbose --no-quiet --no-repo --no-all
    --no-branches --no-mirror --no-delete --no-tags --no-dry-run --no-porcelain --no-force
    --no-force-with-lease --no-force-if-includes --no-recurse-submodules --no-thin
    --no-receive-pack --no-exec --no-set-upstream --no-progress --no-prune --no-follow-tags
    --no-signed --no-atomic --no-push-option`,
  commit: `
    --quiet --verbose --file= --author= --date= --message= --reedit-message= --reuse-message=
    --fixup= --squash= --reset-author --trailer= --signoff --template= --edit --cleanup=
    --status --gpg-sign --all --include --interactive --patch --only --no-verify --dry-run
    --short --branch --ahead-behind --porcelain --long --null --amend --no-post-rewrite
    --untracked-files --pathspec-from-file= --pathspec-file-nul --allow-empty
    --allow-empty-message --verify --post-rewrite --no-quiet --no-verbose --no-file --no-author
    --no-date --no-message --no-reedit-message --no-reuse-message --no-fixup --no-squash
    --no-reset-author --no-signoff --no-template --no-edit --no-cleanup --no-status
    --no-gpg-sign --no-all --no-include --no-interactive --no-patch --no-only --no-dry-run
    --no-short --no-branch --no-ahead-behind --no-porcelain --no-long --no-null --no-amend
    --no-untracked-files --no-pathspec-from-file --no-pathspec-file-nul --no-allow-empty
    --no-allow-empty-message`,
  merge: `
    --stat --summary --log --squash --commit --edit --cleanup= --ff --ff-only
    --rerere-autoupdate --verify-signatures --strategy= --strategy-option= --message= --file
    --into-name= --verbose --quiet --abort --quit --continue --allow-unrelated-histories
    --progress --gpg-sign --autostash --overwrite-ignore --signoff --no-verify --verify
    --no-stat --no-summary --no-log --no-squash --no-commit --no-edit --no-cleanup --no-ff
    --no-rerere-autoupdate --no-verify-signatures --no-strategy --no-strategy-option
    --no-message --no-into-name --no-verbose --no-quiet --no-abort --no-quit --no-continue
    --no-allow-unrelated-histories --no-progress --no-gpg-sign --no-autostash
    --no-overwrite-ignore --no-signoff`,
  rebase: `
    --onto= --keep-base --no-verify --quiet --verbose --no-stat --signoff
    --committer-date-is-author-date --reset-author-date --ignore-date --ignore-whitespace
    --whitespace= --force-rebase --no-ff --continue --skip --abort --quit --edit-todo
    --show-current-patch --apply --merge --interactive --preserve-merges --rerere-autoupdate
    --empty= --keep-empty --autosquash --update-refs --gpg-sign --autostash --exec=
    --allow-empty-message --rebase-merges --fork-point --strategy= --strategy-option= --root
    --reschedule-failed-exec --reapply-cherry-picks --verify --stat --ff --no-onto
    --no-keep-base --no-quiet --no-verbose --no-signoff --no-committer-date-is-author-date
    --no-reset-author-date --no-ignore-date --no-ignore-whitespace --no-whitespace
    --no-force-rebase --no-preserve-merges --no-rerere-autoupdate --no-keep-empty
    --no-autosquash --no-update-refs --no-gpg-sign --no-autostash --no-exec
    --no-allow-empty-message --no-rebase-merges --no-fork-point --no-strategy
    --no-strategy-option --no-root --no-reschedule-failed-exec --no-reapply-cherry-picks`,
  pull: `
    --verbose --quiet --progress --recurse-submodules --rebase --stat --summary --log --signoff
    --squash --commit --edit --cleanup= --ff --ff-only --verify --verify-signatures --autostash
    --strategy= --strategy-option= --gpg-sign --allow-unrelated-histories --all --append
    --upload-pack= --force --tags --prune --jobs --dry-run --keep --depth= --shallow-since=
    --shallow-exclude= --deepen= --unshallow --update-shallow --refmap= --server-option= --ipv4
    --ipv6 --negotiation-tip= --show-forced-updates --set-upstream --no-verbose --no-quiet
    --no-progress --no-recurse-submodules --no-rebase --no-stat --no-summary --no-log
    --no-signoff --no-squash --no-commit --no-edit --no-cleanup --no-ff --no-verify
    --no-verify-signatures --no-autostash --no-strategy --no-strategy-option --no-gpg-sign
    --no-allow-unrelated-histories --no-all --no-append --no-upload-pack --no-force --no-tags
    --no-prune --no-jobs --no-dry-run --no-keep --no-depth --no-shallow-since
    --no-shallow-exclude --no-deepen --no-update-shallow --no-server-option --no-ipv4 --no-ipv6
    --no-negotiation-tip --no-show-forced-updates --no-set-upstream`,
  am: `
    --interactive --no-verify --binary --3way --quiet --signoff --utf8 --keep --keep-non-patch
    --message-id --keep-cr --scissors --quoted-cr= --whitespace= --ignore-space-change
    --ignore-whitespace --directory= --exclude= --include= --patch-format= --reject
    --resolvemsg= --continue --resolved --skip --abort --quit --show-current-patch
    --allow-empty --committer-date-is-author-date --ignore-date --rerere-autoupdate --gpg-sign
    --empty= --rebasing --verify --no-interactive --no-binary --no-3way --no-quiet --no-signoff
    --no-utf8 --no-keep --no-keep-non-patch --no-message-id --no-keep-cr --no-scissors
    --no-whitespace --no-ignore-space-change --no-ignore-whitespace --no-directory --no-exclude
    --no-include --no-patch-format --no-reject --no-resolvemsg
    --no-committer-date-is-author-date --no-ignore-date --no-rerere-autoupdate --no-gpg-sign
    --no-rebasing`,
  reset: `
    --quiet --no-refresh --mixed --soft --hard --merge --keep --recurse-submodules --patch
    --intent-to-add --pathspec-from-file= --pathspec-file-nul --refresh --no-quiet
    --no-recurse-submodules --no-patch --no-intent-to-add --no-pathspec-from-file
    --no-pathspec-file-nul`,
  clean: `
    --quiet --dry-run --force --interactive --exclude= --no-quiet --no-dry-run --no-force
    --no-interactive`,
  checkout: `
    --guess --overlay --quiet --recurse-submodules --progress --merge --conflict= --detach
    --track --force --orphan= --overwrite-ignore --ignore-other-worktrees --ours --theirs
    --patch --ignore-skip-worktree-bits --pathspec-from-file= --pathspec-file-nul --no-guess
    --no-overlay --no-quiet --no-recurse-submodules --no-progress --no-merge --no-conflict
    --no-detach --no-track --no-force --no-orphan --no-overwrite-ignore
    --no-ignore-other-worktrees --no-patch --no-ignore-skip-worktree-bits
    --no-pathspec-from-file --no-pathspec-file-nul`,
  switch: `
    --create= --force-create= --guess --discard-changes --quiet --recurse-submodules --progress
    --merge --conflict= --detach --track --force --orphan= --overwrite-ignore
    --ignore-other-worktrees --no-create --no-force-create --no-guess --no-discard-changes
    --no-quiet --no-recurse-submodules --no-progress --no-merge --no-conflict --no-detach
    --no-track --no-force --no-orphan --no-overwrite-ignore --no-ignore-other-worktrees`,
  restore: `
    --source= --staged --worktree --ignore-unmerged --overlay --quiet --recurse-submodules
    --progress --merge --conflict= --ours --theirs --patch --ignore-skip-worktree-bits
    --pathspec-from-file= --pathspec-file-nul --no-source --no-staged --no-worktree
    --no-ignore-unmerged --no-overlay --no-quiet --no-recurse-submodules --no-progress
    --no-merge --no-conflict --no-patch --no-ignore-skip-worktree-bits --no-pathspec-from-file
    --no-pathspec-file-nul`,
  branch: `
    --verbose --quiet --track --set-upstream --set-upstream-to= --unset-upstream --color
    --remotes --contains --no-contains --with --without --abbrev --all --delete --move
    --omit-empty --copy --list --show-current --create-reflog --edit-description --force
    --merged --no-merged --column --sort= --points-at= --ignore-case --recurse-submodules
    --format= --no-verbose --no-quiet --no-track --no-set-upstream --no-set-upstream-to
    --no-unset-upstream --no-color --no-abbrev --no-delete --no-move --no-omit-empty --no-copy
    --no-list --no-show-current --no-create-reflog --no-edit-description --no-force --no-column
    --no-sort --no-points-at --no-ignore-case --no-recurse-submodules --no-format`,
  add: `
    --dry-run --verbose --interactive --patch --edit --force --update --renormalize
    --intent-to-add --all --ignore-removal --refresh --ignore-errors --ignore-missing --sparse
    --chmod= --warn-embedded-repo --pathspec-from-file= --pathspec-file-nul --no-dry-run
    --no-verbose --no-interactive --no-patch --no-edit --no-force --no-update --no-renormalize
    --no-intent-to-add --no-all --no-ignore-removal --no-refresh --no-ignore-errors
    --no-ignore-missing --no-sparse --no-chmod --no-warn-embedded-repo --no-pathspec-from-file
    --no-pathspec-file-nul`,
};

/** @type {Map<string, Map<string, boolean>>} subcomando -> (opção -> exige valor) */
const GIT_OPTION_TABLES = new Map(
  Object.entries(GIT_LONG_OPTIONS).map(([sub, text]) => [
    sub,
    new Map(
      text
        .split(/\s+/)
        .filter(Boolean)
        .map((o) => [o.replace(/=$/, ''), o.endsWith('=')]),
    ),
  ]),
);

/**
 * Resolve uma opção longa do git como o parse-options: nome exato, prefixo único ou
 * prefixo ambíguo (o git recusa; o chamador decide se isso basta).
 * @param {string} sub subcomando (`push`, `commit`...)
 * @param {string} arg argumento como digitado (`--forc`, `--force-with-l=a:b`)
 * @returns {{ name: string, value: string | null } | { ambiguous: string[] } | null}
 *   `null` quando o subcomando não tem tabela ou a opção não existe nela
 */
export function resolveGitLongOption(sub, arg) {
  const table = GIT_OPTION_TABLES.get(sub);
  if (!table || !arg.startsWith('--') || arg === '--') return null;
  const eq = arg.indexOf('=');
  const typed = eq >= 0 ? arg.slice(0, eq) : arg;
  const value = eq >= 0 ? arg.slice(eq + 1) : null;
  if (table.has(typed)) return { name: typed, value };
  const candidates = [...table.keys()].filter((name) => name.startsWith(typed));
  if (candidates.length === 1) return { name: candidates[0] ?? typed, value };
  if (candidates.length > 1) return { ambiguous: candidates };
  return null;
}

/**
 * Se a opção longa (já resolvida) exige valor no argumento seguinte quando vem sem `=`.
 * @param {string} sub
 * @param {string} name
 */
export function gitOptionTakesValue(sub, name) {
  return GIT_OPTION_TABLES.get(sub)?.get(name) ?? false;
}

/**
 * @typedef {object} InterpreterSpec
 * @property {boolean} clusters aceita agrupar opções curtas (`-Ic`, `-lne`)
 * @property {string} code letras cujo valor é código inline (anexado ou no argumento seguinte)
 * @property {string} value letras com valor anexado ou no argumento seguinte
 * @property {string} attached letras que consomem o resto do agrupamento (nunca o seguinte)
 * @property {string} moduleAttached letras `-M`-like: valor é `Modulo(::X)*(=args)?`; o que vier
 *   além disso (ex.: `perl -M'strict;print %ENV'`) é código inline
 * @property {Record<string, RegExp>} partial letras que consomem parte do agrupamento
 *   (`perl -0777`, `-l0`, `ruby -W2`)
 * @property {string} flags letras sem valor
 * @property {string} envDump letras que imprimem o ambiente inteiro (`php -i`)
 * @property {string} stop letras depois das quais o resto pertence ao programa (`python -m`)
 * @property {boolean} codeStops o código inline encerra as opções (`python -c`)
 * @property {Record<string, 'code' | 'value' | 'flag'>} exact opções curtas exatas de quem
 *   não agrupa (`node -pe` é um apelido, não um agrupamento)
 * @property {string[]} longCode opções longas cujo valor é código
 * @property {string[]} longValue opções longas com valor no argumento seguinte
 * @property {string[]} longEnvDump opções longas que imprimem o ambiente inteiro
 * @property {string[]} moduleValue opções que carregam um módulo (`--import`, `-r`): com URL
 *   `data:` o valor é código inline
 */

/** @type {InterpreterSpec} */
const BASE = {
  clusters: true,
  code: '',
  value: '',
  attached: '',
  moduleAttached: '',
  partial: {},
  flags: '',
  envDump: '',
  stop: '',
  codeStops: false,
  exact: {},
  longCode: [],
  longValue: [],
  longEnvDump: [],
  moduleValue: [],
};

/** Opções do node que carregam módulo antes do programa. */
const NODE_MODULE_OPTIONS = ['--import', '--require', '-r', '--loader', '--experimental-loader'];

/** @type {Record<string, InterpreterSpec>} */
const INTERPRETERS = {
  python: {
    ...BASE,
    code: 'c',
    value: 'WXmQ',
    // biome-ignore lint/security/noSecrets: letras de opções do python, não um segredo
    flags: 'bBdEhiIOPqsSuvVx3tR?',
    stop: 'm',
    codeStops: true,
    longValue: ['--check-hash-based-pycs'],
  },
  perl: {
    ...BASE,
    code: 'eE',
    value: 'I',
    attached: 'imFCdDxV',
    moduleAttached: 'M',
    partial: { 0: /^(?:x[0-9a-fA-F]*|[0-7]*)/, l: /^[0-7]*/ },
    // biome-ignore lint/security/noSecrets: letras de opções do perl, não um segredo
    flags: 'achnpsStTuUvwWX',
  },
  ruby: {
    ...BASE,
    code: 'e',
    value: 'ICEr',
    attached: 'Fix',
    partial: { 0: /^[0-7]*/, W: /^(?:[0-2]|:\S*)?/, K: /^.?/ },
    flags: 'acdlnpsSvwyUh',
  },
  php: {
    ...BASE,
    code: 'rBRE',
    value: 'cdfFStz',
    // biome-ignore lint/security/noSecrets: letras de opções do php, não um segredo
    flags: 'aCehilmnqHsvw?',
    envDump: 'i',
    longCode: ['--run', '--process-begin', '--process-code', '--process-end'],
    longValue: [
      '--php-ini',
      '--define',
      '--file',
      '--process-file',
      '--server',
      '--docroot',
      '--zend-extension',
      '--rf',
      '--rfunction',
      '--rc',
      '--rclass',
      '--re',
      '--rextension',
      '--rz',
      '--rzendextension',
      '--ri',
      '--rextinfo',
    ],
    longEnvDump: ['--info'],
  },
  // node e tsx não agrupam: `-pe` é um apelido; `-pre` é opção inválida.
  node: {
    ...BASE,
    clusters: false,
    exact: {
      '-e': 'code',
      '-p': 'code',
      '-pe': 'code',
      '-r': 'value',
      '-C': 'value',
      '-c': 'flag',
      '-i': 'flag',
      '-h': 'flag',
      '-v': 'flag',
    },
    longCode: ['--eval', '--print'],
    moduleValue: NODE_MODULE_OPTIONS,
  },
  // bun e ts-node agrupam (`-pe`, `-Te`); `-p` pode ser só "imprimir" e o código vir depois.
  bun: {
    ...BASE,
    code: 'ep',
    value: 'rIPCDO',
    flags: 'ihsvTH',
    longCode: ['--eval', '--print'],
    moduleValue: [...NODE_MODULE_OPTIONS, '--preload'],
  },
};

/**
 * Corpo de uma URL `data:` (percent-encoding ou base64); `null` se não decodifica.
 * @param {string} url
 * @returns {string | null}
 */
function decodeDataUrl(url) {
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const meta = url.slice('data:'.length, comma);
  const body = url.slice(comma + 1);
  try {
    if (!/;base64$/i.test(meta)) return decodeURIComponent(body);
    const compact = decodeURIComponent(body).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) return null;
    return Buffer.from(compact, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Valor de opção que carrega módulo: URL `data:` é código inline; se não decodifica, o guard
 * não sabe o que roda (`unknown`).
 * @param {string} flag
 * @param {string} value
 * @param {number} index
 * @param {InterpreterArgs} out
 */
function readModuleValue(flag, value, index, out) {
  if (!/^data:/i.test(value)) return;
  const code = decodeDataUrl(value);
  if (code === null) out.unknown.push(`${flag} ${value.slice(0, 60)}`);
  else out.inline.push({ flag, code, index });
}

/**
 * Família de opções de um interpretador (`python3.13`, `pypy3`, `php8.3`, `nodejs`...).
 * @param {string} bin nome do programa, sem diretório
 * @returns {string | null}
 */
export function interpreterFamily(bin) {
  if (/^(?:python|pypy)(?:\d+(?:\.\d+)*)?t?$/.test(bin)) return 'python';
  if (/^perl(?:\d+(?:\.\d+)*)?$/.test(bin)) return 'perl';
  if (/^ruby(?:\d+(?:\.\d+)*)?$/.test(bin)) return 'ruby';
  if (/^php(?:\d+(?:\.\d+)*)?(?:-cli)?$/.test(bin)) return 'php';
  if (/^(?:node|nodejs)\d*$/.test(bin) || bin === 'tsx') return 'node';
  if (bin === 'bun' || bin === 'ts-node') return 'bun';
  return null;
}

/**
 * Nome canônico de um interpretador com versão ou variante no nome (`python3.13` e `pypy3`
 * -> `python3`, `php8.3` -> `php`, `nodejs` -> `node`), para que as regras escritas para o
 * nome comum valham também para eles. Outros programas voltam sem mudança.
 * @param {string} bin
 */
export function canonicalInterpreter(bin) {
  const family = interpreterFamily(bin);
  if (family === 'python') {
    if (bin === 'python' || bin === 'python2' || bin === 'python3') return bin;
    return /^(?:python|pypy)2/.test(bin) ? 'python2' : 'python3';
  }
  if (family === 'perl' || family === 'ruby' || family === 'php') return family;
  if (family === 'node' && bin !== 'tsx') return 'node';
  return bin;
}

/**
 * @typedef {object} InlineCode
 * @property {string} flag opção que trouxe o código (`-c`, `-e`, `--eval`)
 * @property {string} code
 * @property {number} index índice do argumento que contém o código (o da própria opção
 *   quando anexado, como em `-cCODE` e `--eval=CODE`)
 */

/**
 * @typedef {object} InterpreterArgs
 * @property {InlineCode[]} inline
 * @property {boolean} script há (ou pode haver) programa em arquivo ou módulo
 * @property {string[]} unknown opções que o leitor não sabe analisar (letra fora da tabela,
 *   URL `data:` que não decodifica)
 * @property {string[]} envDump opções que imprimem o ambiente inteiro
 */

/**
 * Lê as opções de um interpretador até o programa (arquivo, módulo ou `-`).
 *
 * Opção longa desconhecida sem `=` pode ou não consumir o argumento seguinte; na dúvida, o
 * seguinte conta como possível programa (`script`) e a leitura continua, para não perder um
 * `-e` depois dele (`node --input-type module -e ...`).
 * @param {string} bin
 * @param {string[]} args
 * @returns {InterpreterArgs}
 */
export function parseInterpreterArgs(bin, args) {
  const spec = INTERPRETERS[interpreterFamily(bin) ?? ''];
  /** @type {InterpreterArgs} */
  const out = { inline: [], script: false, unknown: [], envDump: [] };
  if (!spec) return out;
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '-') return out;
    if (a === '--') {
      out.script = i + 1 < args.length;
      return out;
    }
    if (a.startsWith('--')) {
      i += readLong(spec, a, args, i, out);
      continue;
    }
    if (a.startsWith('-')) {
      const step = spec.clusters
        ? readCluster(spec, a, args, i, out)
        : readExact(spec, a, args, i, out);
      if (step === 'stop') return out;
      i += step;
      continue;
    }
    out.script = true;
    return out;
  }
  return out;
}

/**
 * Opção longa de interpretador.
 * @param {InterpreterSpec} spec
 * @param {string} a
 * @param {string[]} args
 * @param {number} i
 * @param {InterpreterArgs} out
 * @returns {number} quantos argumentos consumiu
 */
function readLong(spec, a, args, i, out) {
  const eq = a.indexOf('=');
  const name = eq >= 0 ? a.slice(0, eq) : a;
  if (spec.longEnvDump.includes(name)) out.envDump.push(name);
  if (spec.moduleValue.includes(name)) {
    if (eq >= 0) readModuleValue(name, a.slice(eq + 1), i, out);
    else readModuleValue(name, args[i + 1] ?? '', i + 1, out);
    return eq >= 0 ? 1 : 2;
  }
  if (spec.longCode.includes(name)) {
    if (eq >= 0) {
      out.inline.push({ flag: name, code: a.slice(eq + 1), index: i });
      return 1;
    }
    out.inline.push({ flag: name, code: args[i + 1] ?? '', index: i + 1 });
    return 2;
  }
  if (eq >= 0) return 1;
  if (spec.longValue.includes(name)) return 2;
  const next = args[i + 1];
  if (next !== undefined && !next.startsWith('-')) {
    out.script = true;
    return 2;
  }
  return 1;
}

/**
 * Opção curta de quem não agrupa (node).
 * @param {InterpreterSpec} spec
 * @param {string} a
 * @param {string[]} args
 * @param {number} i
 * @param {InterpreterArgs} out
 * @returns {number} quantos argumentos consumiu
 */
function readExact(spec, a, args, i, out) {
  const kind = spec.exact[a];
  if (kind === 'code') {
    out.inline.push({ flag: a, code: args[i + 1] ?? '', index: i + 1 });
    return 2;
  }
  if (kind === 'value') {
    if (spec.moduleValue.includes(a)) readModuleValue(a, args[i + 1] ?? '', i + 1, out);
    return 2;
  }
  if (kind !== 'flag') out.unknown.push(a);
  return 1;
}

/**
 * Agrupamento de opções curtas, letra a letra.
 * @param {InterpreterSpec} spec
 * @param {string} a
 * @param {string[]} args
 * @param {number} i
 * @param {InterpreterArgs} out
 * @returns {number | 'stop'} quantos argumentos consumiu, ou `stop` se as opções acabaram
 */
function readCluster(spec, a, args, i, out) {
  let j = 1;
  while (j < a.length) {
    const ch = a.charAt(j);
    const rest = a.slice(j + 1);
    if (spec.code.includes(ch)) {
      const flag = `-${ch}`;
      if (rest === '') {
        out.inline.push({ flag, code: args[i + 1] ?? '', index: i + 1 });
        return spec.codeStops ? 'stop' : 2;
      }
      out.inline.push({ flag, code: rest, index: i });
      // `-pe` em quem trata `-p` como "imprimir": o código pode estar no seguinte.
      if (/^[A-Za-z]{1,3}$/.test(rest) && args[i + 1] !== undefined) {
        out.inline.push({ flag: a, code: args[i + 1] ?? '', index: i + 1 });
      }
      return spec.codeStops ? 'stop' : 1;
    }
    if (spec.value.includes(ch)) {
      if (spec.stop.includes(ch)) {
        out.script = true;
        return 'stop';
      }
      if (spec.moduleValue.includes(`-${ch}`)) {
        if (rest === '') readModuleValue(`-${ch}`, args[i + 1] ?? '', i + 1, out);
        else readModuleValue(`-${ch}`, rest, i, out);
      }
      return rest === '' ? 2 : 1;
    }
    if (spec.moduleAttached.includes(ch)) {
      // `-MModule`, `-MModule::Sub`, `-M-Module`, `-MModule=args` são seguros (perl faz split do
      // `=args`); qualquer coisa além do nome do módulo (`-M'strict;código'`) é código inline.
      const value = rest !== '' ? rest : (args[i + 1] ?? '');
      if (!/^-?[A-Za-z_][\w:]*(?:=[\s\S]*)?$/.test(value)) {
        const after = value.replace(/^-?[A-Za-z_][\w:]*/, '');
        out.inline.push({ flag: `-${ch}`, code: after, index: rest !== '' ? i : i + 1 });
      }
      return rest === '' ? 2 : 1;
    }
    if (spec.attached.includes(ch)) return 1;
    const partial = spec.partial[ch];
    if (partial) {
      j += 1 + (partial.exec(rest)?.[0].length ?? 0);
      continue;
    }
    if (!spec.flags.includes(ch)) {
      out.unknown.push(a);
      return 1;
    }
    if (spec.envDump.includes(ch)) out.envDump.push(`-${ch}`);
    j++;
  }
  return 1;
}

/**
 * `perl`/`ruby`: edição in-place (`-i`, `-pi`, `-i.bak`, `-lpi`, `-0pi`, `-0777pi`) e os
 * arquivos editados. Lê o agrupamento com a mesma tabela de `INTERPRETERS` (letras `partial`
 * como `0` e `l` consomem só o que a regex casa e a leitura continua, então o `i` depois
 * delas é visto), ao contrário da regex antiga que parava no `l`/`0`.
 * @param {string} bin
 * @param {string[]} args
 * @returns {{ inPlace: boolean, files: string[] }}
 */
export function parseInPlaceInterpreter(bin, args) {
  const spec = INTERPRETERS[interpreterFamily(bin) ?? ''];
  if (!spec) return { inPlace: false, files: args.slice(1) };
  let inPlace = false;
  let inline = false;
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k] ?? '';
    if (a === '--') {
      k++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    if (a.startsWith('--')) continue;
    let j = 1;
    while (j < a.length) {
      const ch = a.charAt(j);
      const rest = a.slice(j + 1);
      // `i` (em `attached` nas duas tabelas) liga o in-place e consome o resto como sufixo
      // de backup; precisa ser visto ANTES de `attached` para marcar `inPlace`.
      if (ch === 'i') {
        inPlace = true;
        break;
      }
      if (spec.code.includes(ch)) {
        inline = true;
        if (rest === '') k++;
        break;
      }
      if (spec.value.includes(ch)) {
        if (rest === '') k++;
        break;
      }
      if (spec.attached.includes(ch)) break;
      const partial = spec.partial[ch];
      if (partial) {
        j += 1 + (partial.exec(rest)?.[0].length ?? 0);
        continue;
      }
      // flag conhecida ou letra desconhecida: segue procurando (quem pede confirmação em
      // letra desconhecida é parseInterpreterArgs, chamado em paralelo por checkInterpreter).
      j++;
    }
  }
  const positionals = args.slice(k);
  return { inPlace, files: inline ? positionals : positionals.slice(1) };
}

/**
 * @typedef {object} ShellArgs
 * @property {Array<{ code: string, index: number }>} scripts código de `-c`/`--command`
 * @property {{ value: string, index: number } | null} file script em arquivo
 * @property {boolean} stdin `-s`: o script vem da entrada padrão
 * @property {Array<{ value: string, index: number }>} sourced arquivos carregados como
 *   script (`--rcfile`, `--init-file`)
 */

/** fish: opções no estilo getopt (`-c CMD`, `-C CMD`, `--command=CMD`). */
const FISH = {
  code: 'cC',
  value: 'dopfD',
  longCode: ['--command', '--init-command'],
  longValue: ['--debug', '--debug-output', '--profile', '--profile-startup', '--features'],
};

/**
 * Lê as opções de um shell até o script. Em bash/sh/zsh, `-c` liga o modo comando e o
 * script é o primeiro argumento que não é opção (`bash -c -e 'cmd'`); `-o`/`-O` consomem o
 * argumento seguinte mesmo dentro de um agrupamento (`bash -eo pipefail -c 'cmd'`).
 * @param {string} bin
 * @param {string[]} args
 * @returns {ShellArgs}
 */
export function parseShellArgs(bin, args) {
  /** @type {ShellArgs} */
  const out = { scripts: [], file: null, stdin: false, sourced: [] };
  if (bin === 'fish') return parseFishArgs(args, out);
  let commandMode = false;
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '--' || a === '-') {
      i++;
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      if (name === '--rcfile' || name === '--init-file') {
        out.sourced.push(
          eq >= 0
            ? { value: a.slice(eq + 1), index: i }
            : { value: args[i + 1] ?? '', index: i + 1 },
        );
        i += eq >= 0 ? 1 : 2;
        continue;
      }
      i++;
      continue;
    }
    if (/^[-+]./.test(a)) {
      let take = 0;
      for (const ch of a.slice(1)) {
        if (ch === 'c' && a.startsWith('-')) commandMode = true;
        else if (ch === 's' && a.startsWith('-')) out.stdin = true;
        else if (ch === 'o' || ch === 'O') take++;
      }
      i += 1 + take;
      continue;
    }
    break;
  }
  if (commandMode) {
    out.stdin = false;
    out.scripts.push({ code: args[i] ?? '', index: i < args.length ? i : -1 });
  } else if (!out.stdin && i < args.length) {
    out.file = { value: args[i] ?? '', index: i };
  }
  return out;
}

/**
 * @param {string[]} args
 * @param {ShellArgs} out
 * @returns {ShellArgs}
 */
function parseFishArgs(args, out) {
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '--') {
      i++;
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      if (FISH.longCode.includes(name)) {
        out.scripts.push(
          eq >= 0 ? { code: a.slice(eq + 1), index: i } : { code: args[i + 1] ?? '', index: i + 1 },
        );
        i += eq >= 0 ? 1 : 2;
        continue;
      }
      i += eq < 0 && FISH.longValue.includes(name) ? 2 : 1;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      i += readFishCluster(a, args, i, out);
      continue;
    }
    break;
  }
  if (i < args.length) out.file = { value: args[i] ?? '', index: i };
  return out;
}

/**
 * @param {string} a
 * @param {string[]} args
 * @param {number} i
 * @param {ShellArgs} out
 * @returns {number} quantos argumentos consumiu
 */
function readFishCluster(a, args, i, out) {
  for (let j = 1; j < a.length; j++) {
    const ch = a.charAt(j);
    const rest = a.slice(j + 1);
    if (FISH.code.includes(ch)) {
      if (rest !== '') {
        out.scripts.push({ code: rest, index: i });
        return 1;
      }
      out.scripts.push({ code: args[i + 1] ?? '', index: i + 1 });
      return 2;
    }
    if (FISH.value.includes(ch)) return rest === '' ? 2 : 1;
  }
  return 1;
}
