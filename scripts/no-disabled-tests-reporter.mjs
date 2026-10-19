// @ts-check
/**
 * Reporter do node:test que reprova a execução (exit 1) quando algum teste ou suíte termina
 * pulado ou pendente (regra 3 do CLAUDE.md), qualquer que seja a sintaxe: modificador, opção
 * literal ou em variável, biome-ignore, pulo ou pendência em tempo de execução. O Biome só vê
 * a sintaxe, e o `node --test` sai com 0 com testes pulados, pendentes e até com pendente que
 * falha. É o equivalente, nas suítes node:test, ao reporter dos pacotes Vitest
 * (test-support/vitest-no-disabled-tests-reporter.ts, usado por core, db e web).
 *
 * Uso (package.json, `test:root` e `test:hooks`), um destino por reporter:
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=./scripts/no-disabled-tests-reporter.mjs \
 *     --test-reporter-destination=stderr ...
 *
 * Execução filtrada (--test-name-pattern, --test-skip-pattern, --test-only): o node:test não
 * reporta o que o filtro deixou de fora, então só os testes selecionados contam.
 *
 * Prova: scripts/no-disabled-tests-reporter.test.mjs (em `pnpm test:root`), que também fixa as
 * opções dos dois scripts.
 */
import path from 'node:path';

/**
 * Campos usados de `event.data` em test:pass e test:fail (API de reporters do node:test).
 * @typedef {object} TestEventData
 * @property {string} name
 * @property {string} [file]
 * @property {number} [line]
 * @property {number} [column]
 * @property {string | boolean} [skip]
 * @property {string | boolean} [todo]
 * @property {{ type?: string }} [details]
 */

/**
 * Motivo legível de um evento de teste pulado ou pendente; undefined se o teste rodou.
 * Um pendente que falha chega como test:fail e também conta.
 * @param {TestEventData} data
 */
function disabledReason(data) {
  const suite = data.details?.type === 'suite';
  /** @type {[string, string | boolean | undefined][]} */
  const marks = [
    [suite ? 'suíte pulada' : 'pulado', data.skip],
    [suite ? 'suíte pendente' : 'pendente', data.todo],
  ];
  for (const [label, value] of marks) {
    if (value === undefined) continue;
    return typeof value === 'string' && value !== '' ? `${label}: ${value}` : label;
  }
  return undefined;
}

/** Arquivo:linha:coluna do teste, relativo à raiz quando está dentro dela. */
function location(/** @type {TestEventData} */ data) {
  if (data.file === undefined) return '?';
  const relative = path.relative(process.cwd(), data.file);
  const file = relative.startsWith('..') ? data.file : relative;
  return data.line === undefined ? file : `${file}:${String(data.line)}:${String(data.column)}`;
}

/**
 * @param {AsyncIterable<{ type: string, data: TestEventData }>} source
 * @returns {AsyncGenerator<string>}
 */
export default async function* noDisabledTestsReporter(source) {
  /** @type {string[]} */
  const offenders = [];
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const why = disabledReason(event.data);
    if (why === undefined) continue;
    offenders.push(`${location(event.data)} > ${event.data.name} [${why}]`);
  }
  if (offenders.length === 0) return;

  process.exitCode = 1;
  yield [
    '',
    `Testes desligados (${String(offenders.length)}): pulado ou pendente não verifica nada ` +
      '(regra 3 do CLAUDE.md).',
    ...offenders.map((offender) => `  - ${offender}`),
    'Corrija o teste ou o código e remova a opção, o modificador ou o pulo.',
    '',
  ].join('\n');
}
