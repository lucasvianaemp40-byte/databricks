// @ts-check
/**
 * Analisador léxico de shell (subconjunto do bash) usado pelos hooks de proteção.
 *
 * Objetivo: decompor uma linha de comando em comandos simples, com as palavras já sem aspas
 * e sem escapes, para que as regras de segurança não sejam contornadas por `r''m`, `"rm"`,
 * `\rm`, `$'\x72m'`, `{rm,-rf,/}`, `sh -c '...'`, `$(...)`, crases, heredocs etc.
 *
 * Não é um interpretador: não expande variáveis nem globs. Palavras com expansão ficam
 * marcadas como `dynamic` e o chamador decide (por padrão, pede confirmação). Quando a
 * estrutura não é reconhecível (aspas sem fechamento, parênteses desbalanceados), o
 * resultado traz `errors`; o chamador trata isso como "não sei analisar" (fail-closed).
 */

/**
 * @typedef {object} Redirect
 * @property {string} op operador (`>`, `>>`, `<`, `<<`, `<<<`, `>&`, `&>`...)
 * @property {string} target alvo já sem aspas (arquivo, fd ou delimitador do heredoc)
 * @property {boolean} dynamic o alvo contém expansão
 * @property {string} [fd] descritor explícito antes do operador (ex.: `2>`)
 */

/**
 * @typedef {object} Heredoc
 * @property {string} delimiter
 * @property {boolean} expand o corpo passa por expansão (delimitador sem aspas)
 * @property {string} body
 */

/**
 * @typedef {object} SimpleCommand
 * @property {string[]} words palavras sem aspas, após expansão de chaves
 * @property {boolean[]} dynamic `true` quando a palavra contém `$`, `$(...)` ou crase
 * @property {Redirect[]} redirects
 * @property {Heredoc[]} heredocs
 * @property {string[]} hereStrings conteúdo de `<<<`
 * @property {string[]} substitutions scripts de `$(...)` e crases (executam)
 * @property {string[]} processSubstitutions scripts de `<(...)` e `>(...)` (executam)
 * @property {boolean} pipedIn recebe stdin de um pipe
 * @property {boolean} pipedOut envia stdout para um pipe
 * @property {number} pipeline índice do pipeline; comandos ligados por `|` compartilham o índice
 */

/**
 * @typedef {object} ParseResult
 * @property {SimpleCommand[]} commands
 * @property {string[]} errors
 */

const MAX_BRACE_EXPANSIONS = 64;
const REDIRECT_OPS = ['<<<', '<<-', '&>>', '<<', '<>', '<&', '>>', '>&', '>|', '&>', '<', '>'];
const CONTROL_OPS = [';;&', ';;', ';&', '&&', '||', '|&', ';', '|', '&', '(', ')'];

/** @param {string} ch */
const isBlank = (ch) => ch === ' ' || ch === '\t' || ch === '\r';
/** @param {string} ch */
const isMeta = (ch) =>
  ch === ' ' ||
  ch === '\t' ||
  ch === '\r' ||
  ch === '\n' ||
  ch === ';' ||
  ch === '&' ||
  ch === '|' ||
  ch === '(' ||
  ch === ')' ||
  ch === '<' ||
  ch === '>';

/**
 * Decodifica o conteúdo de `$'...'` (ANSI-C quoting).
 * @param {string} raw conteúdo entre as aspas
 * @returns {string}
 */
export function decodeAnsiC(raw) {
  /** @type {Record<string, string>} */
  const simple = {
    a: '\u0007',
    b: '\b',
    e: '\u001b',
    E: '\u001b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '?': '?',
  };
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch !== '\\' || i + 1 >= raw.length) {
      out += ch;
      continue;
    }
    const next = raw.charAt(i + 1);
    const mapped = simple[next];
    if (mapped !== undefined) {
      out += mapped;
      i++;
      continue;
    }
    if (next === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(raw.slice(i + 2));
      if (m) {
        out += String.fromCharCode(Number.parseInt(m[0], 16));
        i += 1 + m[0].length;
        continue;
      }
    }
    if (next === 'u' || next === 'U') {
      const max = next === 'u' ? 4 : 8;
      const m = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(raw.slice(i + 2));
      if (m) {
        out += String.fromCodePoint(Number.parseInt(m[0], 16));
        i += 1 + m[0].length;
        continue;
      }
    }
    if (next >= '0' && next <= '7') {
      const m = /^[0-7]{1,3}/.exec(raw.slice(i + 1));
      if (m) {
        out += String.fromCharCode(Number.parseInt(m[0], 8));
        i += m[0].length;
        continue;
      }
    }
    if (next === 'c' && i + 2 < raw.length) {
      out += String.fromCharCode(raw.charCodeAt(i + 2) & 0x1f);
      i += 2;
      continue;
    }
    out += ch + next;
    i++;
  }
  return out;
}

/**
 * Encontra o fim de uma construção balanceada que começa logo após `open`
 * (por exemplo, o `)` que fecha `$(`). Respeita aspas, escapes, crases e aninhamento.
 * @param {string} src
 * @param {number} start índice logo após o caractere de abertura
 * @param {string} open
 * @param {string} close
 * @returns {number} índice do caractere de fechamento, ou -1
 */
export function findBalanced(src, start, open, close) {
  let depth = 1;
  let i = start;
  /** @type {Array<{ delimiter: string, stripTabs: boolean }>} */
  let pendingHeredocs = [];
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n' && pendingHeredocs.length > 0) {
      i = skipHeredocBodies(src, i + 1, pendingHeredocs);
      pendingHeredocs = [];
      continue;
    }
    if (ch === '<' && src.charAt(i + 1) === '<' && src.charAt(i + 2) !== '<') {
      let j = i + 2;
      const stripTabs = src.charAt(j) === '-';
      if (stripTabs) j++;
      while (isBlank(src.charAt(j))) j++;
      const m = /^(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|()<>'"]+))/.exec(src.slice(j));
      if (m) {
        pendingHeredocs.push({ delimiter: m[1] ?? m[2] ?? m[3] ?? '', stripTabs });
        i = j + m[0].length;
        continue;
      }
    }
    if (ch === '#' && (i === start || /[\s;&|(]/.test(src.charAt(i - 1)))) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      const end = findDoubleQuoteEnd(src, i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = findBacktickEnd(src, i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Pula os corpos de heredocs pendentes a partir do início de uma linha.
 * @param {string} src
 * @param {number} from índice do início da linha seguinte ao operador `<<`
 * @param {Array<{ delimiter: string, stripTabs: boolean }>} pending
 * @returns {number} índice logo após a linha do último delimitador
 */
function skipHeredocBodies(src, from, pending) {
  let i = from;
  for (const heredoc of pending) {
    while (i < src.length) {
      const nl = src.indexOf('\n', i);
      const lineEnd = nl === -1 ? src.length : nl;
      let line = src.slice(i, lineEnd);
      if (heredoc.stripTabs) line = line.replace(/^\t+/, '');
      i = nl === -1 ? src.length : nl + 1;
      if (line === heredoc.delimiter) break;
    }
  }
  return i;
}

/**
 * @param {string} src
 * @param {number} start índice logo após a aspa dupla de abertura
 * @returns {number} índice da aspa de fechamento, ou -1
 */
function findDoubleQuoteEnd(src, start) {
  let i = start;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i;
    if (ch === '`') {
      const end = findBacktickEnd(src, i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '$' && src.charAt(i + 1) === '(') {
      const end = findBalanced(src, i + 2, '(', ')');
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * @param {string} src
 * @param {number} start índice logo após a crase de abertura
 * @returns {number}
 */
function findBacktickEnd(src, start) {
  let i = start;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i;
    i++;
  }
  return -1;
}

/**
 * Extrai os scripts de `$(...)` e crases de um texto sujeito a expansão (conteúdo entre
 * aspas duplas, corpo de heredoc sem aspas, valor de `${...}`).
 * @param {string} text
 * @returns {{ subs: string[], errors: string[] }}
 */
export function findSubstitutions(text) {
  /** @type {string[]} */
  const subs = [];
  /** @type {string[]} */
  const errors = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '$' && text.charAt(i + 1) === '(' && text.charAt(i + 2) === '(') {
      const end = text.indexOf('))', i + 3);
      if (end === -1) {
        errors.push('expressão aritmética sem fechamento');
        break;
      }
      i = end + 2;
      continue;
    }
    if (ch === '$' && text.charAt(i + 1) === '(') {
      const end = findBalanced(text, i + 2, '(', ')');
      if (end === -1) {
        errors.push('substituição de comando sem fechamento');
        break;
      }
      subs.push(text.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = findBacktickEnd(text, i + 1);
      if (end === -1) {
        errors.push('crase sem fechamento');
        break;
      }
      subs.push(text.slice(i + 1, end).replace(/\\([`$\\])/g, '$1'));
      i = end + 1;
      continue;
    }
    i++;
  }
  return { subs, errors };
}

/**
 * Termos de uma sequência do bash, sem as chaves (`1..3`, `a..e..2`, `01..10`). Segue o bash
 * 5.2: o passo vale em módulo (0 vale 1); a largura é fixa quando um extremo tem zero à
 * esquerda (`01`, `-01`, não `0`, `-0` nem `+01`); letras andam pela tabela ASCII (`Z..b`
 * inclui `[`, `\` e `]`).
 * @param {string} content texto entre as chaves
 * @param {number} limit máximo de termos
 * @returns {string[] | null | undefined} os termos; `null` quando passam de `limit`;
 *   `undefined` quando não é sequência (o bash deixa a chave literal)
 */
export function braceSequenceTerms(content, limit) {
  const int = /^([+-]?\d+)\.\.([+-]?\d+)(?:\.\.([+-]?\d+))?$/.exec(content);
  const chr = int ? null : /^([A-Za-z])\.\.([A-Za-z])(?:\.\.([+-]?\d+))?$/.exec(content);
  const m = int ?? chr;
  if (!m) return undefined;
  const step = Math.abs(Number.parseInt(m[3] ?? '1', 10)) || 1;
  const lhs = m[1] ?? '';
  const rhs = m[2] ?? '';
  const from = chr ? lhs.charCodeAt(0) : Number(lhs);
  const to = chr ? rhs.charCodeAt(0) : Number(rhs);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
  const count = Math.floor(Math.abs(to - from) / step) + 1;
  if (count > limit) return null;
  const dir = to >= from ? 1 : -1;
  /** @param {string} s */
  const zeroPadded = (s) => /^-?0\d/.test(s);
  const width = !chr && (zeroPadded(lhs) || zeroPadded(rhs)) ? Math.max(lhs.length, rhs.length) : 0;
  /** @type {string[]} */
  const terms = [];
  for (let k = 0; k < count; k++) {
    const n = from + dir * step * k;
    if (chr) {
      terms.push(String.fromCharCode(n));
      continue;
    }
    const sign = n < 0 ? '-' : '';
    terms.push(sign + String(Math.abs(n)).padStart(width - sign.length, '0'));
  }
  return terms;
}

/**
 * Expansão de chaves no estilo do bash: listas com vírgula (`{a,b}c` -> `ac bc`) e
 * sequências (`{1..3}`, `{a..c}`), na ordem do bash. Só considera chaves e vírgulas que vieram
 * de trechos sem aspas (máscara `false`). Devolve no máximo MAX_BRACE_EXPANSIONS palavras.
 * @param {string} value
 * @param {boolean[]} literal máscara: `true` para caracteres vindos de aspas ou escapes
 * @returns {string[]}
 */
export function expandBraces(value, literal) {
  return expandBraceWord(value, literal).words;
}

/**
 * @typedef {{ value: string, literal: boolean[] }} BraceItem
 */

/**
 * Alternativas de um item no grupo de chaves `[open, close]` dele, na ordem do bash.
 * @param {BraceItem} item
 * @param {number} open
 * @param {number} close
 * @param {BraceItem[]} parts
 * @returns {BraceItem[]}
 */
function braceAlternatives(item, open, close, parts) {
  const prefix = item.value.slice(0, open);
  const prefixMask = item.literal.slice(0, open);
  const suffix = item.value.slice(close + 1);
  const suffixMask = item.literal.slice(close + 1);
  return parts.map((part) => ({
    value: prefix + part.value + suffix,
    literal: [...prefixMask, ...part.literal, ...suffixMask],
  }));
}

/**
 * Como `expandBraces`, mas diz se a expansão saiu inteira. `complete: false` quando o produto
 * ou uma sequência passa de MAX_BRACE_EXPANSIONS: o chamador não pode tratar as palavras
 * devolvidas como todas as que o bash geraria (fail-closed).
 *
 * `leftovers`: quando o teto corta a expansão, o que ficou na pilha não some. A expansão é em
 * profundidade, então 64 palavras de uma alternativa (`{{1..64},.env}`) esgotavam o teto e
 * a alternativa seguinte (`.env`) nem era vista. Item restante sem chave vira palavra; item
 * com um grupo só vira as alternativas completas dele (`.e{n,x}v`). Itens com mais de um
 * grupo continuam fora (é o produto que o teto limita) e só valem pelo erro de análise.
 * @param {string} value
 * @param {boolean[]} literal
 * @returns {{ words: string[], complete: boolean, leftovers: string[] }}
 */
function expandBraceWord(value, literal) {
  // Em profundidade, alternativa da esquerda primeiro: é a ordem em que o bash gera as palavras.
  /** @type {BraceItem[]} */
  const stack = [{ value, literal }];
  /** @type {string[]} */
  const words = [];
  let complete = true;
  while (stack.length > 0 && words.length < MAX_BRACE_EXPANSIONS) {
    const item = /** @type {BraceItem} */ (stack.pop());
    const group = findBraceGroup(item.value, item.literal);
    if (!group) {
      words.push(item.value);
      continue;
    }
    if (group.parts === null) {
      complete = false;
      continue;
    }
    const alternatives = braceAlternatives(item, group.open, group.close, group.parts);
    for (let k = alternatives.length - 1; k >= 0; k--) {
      stack.push(/** @type {BraceItem} */ (alternatives[k]));
    }
  }
  if (stack.length === 0) return { words, complete, leftovers: [] };
  /** @type {string[]} */
  const leftovers = [];
  // Do topo para a base: a ordem em que o bash geraria as palavras.
  for (let k = stack.length - 1; k >= 0; k--) {
    const item = /** @type {BraceItem} */ (stack[k]);
    const group = findBraceGroup(item.value, item.literal);
    if (!group) {
      leftovers.push(item.value);
      continue;
    }
    if (group.parts === null) continue;
    for (const next of braceAlternatives(item, group.open, group.close, group.parts)) {
      if (!findBraceGroup(next.value, next.literal)) leftovers.push(next.value);
    }
  }
  return { words, complete: false, leftovers };
}

/**
 * Primeiro grupo de chaves expansível: lista com vírgula ou sequência válida. `parts: null`
 * quando a sequência passa do teto (não dá para expandir inteira).
 * @param {string} value
 * @param {boolean[]} literal
 * @returns {{ open: number, close: number, parts: Array<{ value: string, literal: boolean[] }> | null } | null}
 */
function findBraceGroup(value, literal) {
  for (let open = 0; open < value.length; open++) {
    if (value.charAt(open) !== '{' || literal[open]) continue;
    if (open > 0 && value.charAt(open - 1) === '$' && !literal[open - 1]) continue;
    let depth = 0;
    /** @type {number[]} */
    const commas = [];
    for (let j = open + 1; j < value.length; j++) {
      if (literal[j]) continue;
      const ch = value.charAt(j);
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (depth === 0) {
          if (commas.length === 0) {
            // Sequência só vale sem aspas em nenhum caractere: `{1'..'3}` fica literal.
            const quoted = literal.slice(open + 1, j).some(Boolean);
            const terms = quoted
              ? undefined
              : braceSequenceTerms(value.slice(open + 1, j), MAX_BRACE_EXPANSIONS);
            if (terms === undefined) break;
            if (terms === null) return { open, close: j, parts: null };
            return {
              open,
              close: j,
              parts: terms.map((t) => ({ value: t, literal: Array(t.length).fill(false) })),
            };
          }
          /** @type {Array<{ value: string, literal: boolean[] }>} */
          const parts = [];
          let from = open + 1;
          for (const c of [...commas, j]) {
            parts.push({ value: value.slice(from, c), literal: literal.slice(from, c) });
            from = c + 1;
          }
          return { open, close: j, parts };
        }
        depth--;
      } else if (ch === ',' && depth === 0) {
        commas.push(j);
      }
    }
  }
  return null;
}

/**
 * @typedef {object} WordToken
 * @property {'word'} type
 * @property {string} value
 * @property {boolean[]} literal
 * @property {boolean} dynamic
 * @property {boolean} quoted
 * @property {string[]} subs
 * @property {string[]} procSubs
 * @property {number} end índice logo após a palavra
 */

/**
 * @typedef {{ type: 'op', value: string }} OpToken
 * @typedef {{ type: 'redir', op: string, fd?: string, heredoc?: Heredoc }} RedirToken
 * @typedef {WordToken | OpToken | RedirToken} Token
 */

class Lexer {
  /** @param {string} src */
  constructor(src) {
    this.src = src;
    this.i = 0;
    /** @type {Token[]} */
    this.tokens = [];
    /** @type {string[]} */
    this.errors = [];
    /** @type {Array<{ heredoc: Heredoc, stripTabs: boolean }>} */
    this.pendingHeredocs = [];
  }

  run() {
    const { src } = this;
    while (this.i < src.length) {
      const ch = src.charAt(this.i);
      if (isBlank(ch)) {
        this.i++;
        continue;
      }
      if (ch === '\\' && src.charAt(this.i + 1) === '\n') {
        this.i += 2;
        continue;
      }
      if (ch === '#') {
        while (this.i < src.length && src.charAt(this.i) !== '\n') this.i++;
        continue;
      }
      if (ch === '\n') {
        this.tokens.push({ type: 'op', value: '\n' });
        this.i++;
        this.readPendingHeredocs();
        continue;
      }
      if ((ch === '<' || ch === '>') && src.charAt(this.i + 1) === '(') {
        this.tokens.push(this.readWord());
        continue;
      }
      const redir = REDIRECT_OPS.find((op) => src.startsWith(op, this.i));
      if (redir) {
        this.i += redir.length;
        this.pushRedirect(redir, undefined);
        continue;
      }
      const control = CONTROL_OPS.find((op) => src.startsWith(op, this.i));
      if (control) {
        this.tokens.push({ type: 'op', value: control });
        this.i += control.length;
        continue;
      }
      const word = this.readWord();
      const after = src.charAt(this.i);
      if (
        /^\d+$/.test(word.value) &&
        !word.quoted &&
        (after === '<' || after === '>') &&
        src.charAt(this.i + 1) !== '('
      ) {
        const op = REDIRECT_OPS.find((o) => src.startsWith(o, this.i));
        if (op) {
          this.i += op.length;
          this.pushRedirect(op, word.value);
          continue;
        }
      }
      this.tokens.push(word);
    }
    if (this.pendingHeredocs.length > 0) {
      // Heredoc na última linha sem corpo: o bash avisa e usa corpo vazio.
      this.pendingHeredocs = [];
    }
    return this;
  }

  /**
   * @param {string} op
   * @param {string | undefined} fd
   */
  pushRedirect(op, fd) {
    /** @type {RedirToken} */
    const token = { type: 'redir', op };
    if (fd !== undefined) token.fd = fd;
    if (op === '<<' || op === '<<-') {
      while (isBlank(this.src.charAt(this.i))) this.i++;
      const delimWord = this.readWord();
      if (delimWord.value === '') {
        this.errors.push('heredoc sem delimitador');
        this.tokens.push(token);
        return;
      }
      /** @type {Heredoc} */
      const heredoc = { delimiter: delimWord.value, expand: !delimWord.quoted, body: '' };
      token.heredoc = heredoc;
      this.pendingHeredocs.push({ heredoc, stripTabs: op === '<<-' });
      this.tokens.push(token);
      this.tokens.push({ ...delimWord, dynamic: false, subs: [], procSubs: [] });
      return;
    }
    this.tokens.push(token);
  }

  readPendingHeredocs() {
    const { src } = this;
    for (const pending of this.pendingHeredocs) {
      /** @type {string[]} */
      const lines = [];
      let closed = false;
      while (this.i <= src.length) {
        const nl = src.indexOf('\n', this.i);
        const lineEnd = nl === -1 ? src.length : nl;
        let line = src.slice(this.i, lineEnd);
        this.i = nl === -1 ? src.length + 1 : nl + 1;
        if (pending.stripTabs) line = line.replace(/^\t+/, '');
        if (line === pending.heredoc.delimiter) {
          closed = true;
          break;
        }
        lines.push(line);
        if (nl === -1) break;
      }
      if (this.i > src.length) this.i = src.length;
      pending.heredoc.body = lines.join('\n');
      if (!closed) this.errors.push(`heredoc "${pending.heredoc.delimiter}" sem terminador`);
    }
    this.pendingHeredocs = [];
  }

  /** @returns {WordToken} */
  readWord() {
    const { src } = this;
    let value = '';
    /** @type {boolean[]} */
    const literal = [];
    let dynamic = false;
    let quoted = false;
    /** @type {string[]} */
    const subs = [];
    /** @type {string[]} */
    const procSubs = [];
    /**
     * @param {string} text
     * @param {boolean} isLiteral
     */
    const append = (text, isLiteral) => {
      value += text;
      for (let k = 0; k < text.length; k++) literal.push(isLiteral);
    };

    while (this.i < src.length) {
      const ch = src.charAt(this.i);
      if (value === '' && literal.length === 0 && (ch === '<' || ch === '>')) {
        if (src.charAt(this.i + 1) === '(') {
          const end = findBalanced(src, this.i + 2, '(', ')');
          if (end === -1) {
            this.errors.push('substituição de processo sem fechamento');
            this.i = src.length;
            break;
          }
          procSubs.push(src.slice(this.i + 2, end));
          append('/dev/fd/63', false);
          dynamic = true;
          this.i = end + 1;
          continue;
        }
      }
      if (isMeta(ch)) break;
      if (ch === '\\') {
        if (src.charAt(this.i + 1) === '\n') {
          this.i += 2;
          continue;
        }
        if (this.i + 1 < src.length) append(src.charAt(this.i + 1), true);
        this.i += 2;
        quoted = true;
        continue;
      }
      if (ch === "'") {
        const end = src.indexOf("'", this.i + 1);
        if (end === -1) {
          this.errors.push('aspas simples sem fechamento');
          append(src.slice(this.i + 1), true);
          this.i = src.length;
          break;
        }
        append(src.slice(this.i + 1, end), true);
        quoted = true;
        this.i = end + 1;
        continue;
      }
      if (ch === '$' && src.charAt(this.i + 1) === "'") {
        let j = this.i + 2;
        while (j < src.length && src.charAt(j) !== "'") j += src.charAt(j) === '\\' ? 2 : 1;
        if (j >= src.length) {
          this.errors.push("aspas $'...' sem fechamento");
          this.i = src.length;
          break;
        }
        append(decodeAnsiC(src.slice(this.i + 2, j)), true);
        quoted = true;
        this.i = j + 1;
        continue;
      }
      if (ch === '"' || (ch === '$' && src.charAt(this.i + 1) === '"')) {
        const start = ch === '"' ? this.i + 1 : this.i + 2;
        const end = findDoubleQuoteEnd(src, start);
        if (end === -1) {
          this.errors.push('aspas duplas sem fechamento');
          this.i = src.length;
          break;
        }
        const inner = src.slice(start, end);
        const found = findSubstitutions(inner);
        subs.push(...found.subs);
        this.errors.push(...found.errors);
        if (/\$[A-Za-z_{(0-9@*#?$!-]/.test(inner) || inner.includes('`')) dynamic = true;
        append(
          inner.replace(/\\([$`"\\\n])/g, (_m, c) => (c === '\n' ? '' : c)),
          true,
        );
        quoted = true;
        this.i = end + 1;
        continue;
      }
      if (ch === '`') {
        const end = findBacktickEnd(src, this.i + 1);
        if (end === -1) {
          this.errors.push('crase sem fechamento');
          this.i = src.length;
          break;
        }
        subs.push(src.slice(this.i + 1, end).replace(/\\([`$\\])/g, '$1'));
        append(src.slice(this.i, end + 1), false);
        dynamic = true;
        this.i = end + 1;
        continue;
      }
      if (ch === '$' && src.charAt(this.i + 1) === '(') {
        if (src.charAt(this.i + 2) === '(') {
          const end = src.indexOf('))', this.i + 3);
          if (end === -1) {
            this.errors.push('expressão aritmética sem fechamento');
            this.i = src.length;
            break;
          }
          append(src.slice(this.i, end + 2), false);
          dynamic = true;
          this.i = end + 2;
          continue;
        }
        const end = findBalanced(src, this.i + 2, '(', ')');
        if (end === -1) {
          this.errors.push('substituição de comando sem fechamento');
          this.i = src.length;
          break;
        }
        subs.push(src.slice(this.i + 2, end));
        append(src.slice(this.i, end + 1), false);
        dynamic = true;
        this.i = end + 1;
        continue;
      }
      if (ch === '$' && src.charAt(this.i + 1) === '{') {
        const end = findBalanced(src, this.i + 2, '{', '}');
        if (end === -1) {
          this.errors.push('expansão de variável entre chaves sem fechamento');
          this.i = src.length;
          break;
        }
        const found = findSubstitutions(src.slice(this.i + 2, end));
        subs.push(...found.subs);
        this.errors.push(...found.errors);
        append(src.slice(this.i, end + 1), false);
        dynamic = true;
        this.i = end + 1;
        continue;
      }
      if (ch === '$' && /[A-Za-z_0-9@*#?$!-]/.test(src.charAt(this.i + 1))) {
        const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(this.i));
        const text = m ? m[0] : '$';
        append(text, false);
        dynamic = true;
        this.i += text.length;
        continue;
      }
      append(ch, false);
      this.i++;
    }
    return { type: 'word', value, literal, dynamic, quoted, subs, procSubs, end: this.i };
  }
}

/** @returns {SimpleCommand} */
function emptyCommand() {
  return {
    words: [],
    dynamic: [],
    redirects: [],
    heredocs: [],
    hereStrings: [],
    substitutions: [],
    processSubstitutions: [],
    pipedIn: false,
    pipedOut: false,
    pipeline: 0,
  };
}

/**
 * Decompõe um script de shell em comandos simples.
 * @param {string} script
 * @returns {ParseResult}
 */
export function parseShell(script) {
  const lexer = new Lexer(String(script)).run();
  /** @type {SimpleCommand[]} */
  const commands = [];
  const errors = [...lexer.errors];
  let current = emptyCommand();
  let pipeline = 0;
  let pipedIn = false;

  /** @param {boolean} pipedOut */
  const finish = (pipedOut) => {
    const hasContent =
      current.words.length > 0 ||
      current.redirects.length > 0 ||
      current.substitutions.length > 0 ||
      current.processSubstitutions.length > 0;
    if (hasContent) {
      current.pipedIn = pipedIn;
      current.pipedOut = pipedOut;
      current.pipeline = pipeline;
      commands.push(current);
    }
    current = emptyCommand();
  };

  const { tokens } = lexer;
  for (let t = 0; t < tokens.length; t++) {
    const token = /** @type {Token} */ (tokens[t]);
    if (token.type === 'op') {
      if (token.value === '|' || token.value === '|&') {
        finish(true);
        pipedIn = true;
      } else {
        finish(false);
        pipeline++;
        pipedIn = false;
      }
      continue;
    }
    if (token.type === 'redir') {
      const target = tokens[t + 1];
      if (target?.type !== 'word') {
        errors.push(`redirecionamento "${token.op}" sem alvo`);
        continue;
      }
      t++;
      current.substitutions.push(...target.subs);
      current.processSubstitutions.push(...target.procSubs);
      if (token.heredoc) {
        current.heredocs.push(token.heredoc);
      } else if (token.op === '<<<') {
        current.hereStrings.push(target.value);
      } else {
        /** @type {Redirect} */
        const redirect = { op: token.op, target: target.value, dynamic: target.dynamic };
        if (token.fd !== undefined) redirect.fd = token.fd;
        current.redirects.push(redirect);
      }
      continue;
    }
    current.substitutions.push(...token.subs);
    current.processSubstitutions.push(...token.procSubs);
    const expanded = expandBraceWord(token.value, token.literal);
    for (const value of [...expanded.words, ...expanded.leftovers]) {
      current.words.push(value);
      current.dynamic.push(token.dynamic);
    }
    if (!expanded.complete) {
      // Fail-closed: além do erro (o chamador pede confirmação), a palavra original segue para
      // a análise, que reavalia o glob (`.claude/{1..100}` sob .claude/ é negado).
      errors.push(`expansão de chaves grande demais para análise (${token.value.slice(0, 80)})`);
      current.words.push(token.value);
      current.dynamic.push(token.dynamic);
    }
  }
  finish(false);
  return { commands, errors };
}
