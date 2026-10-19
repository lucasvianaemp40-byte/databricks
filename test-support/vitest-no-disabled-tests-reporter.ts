import path from 'node:path';

/**
 * Portão pelo RESULTADO (regra 3 do CLAUDE.md), compartilhado pelos pacotes Vitest
 * (@salon/scheduling-core, @salon/db e @salon/web): reprova a execução (exit 1) se algum teste
 * terminar pulado, pendente ou com falha esperada, qualquer que seja a sintaxe que o desligou:
 * modificador, opção literal ou em variável, spread, tag, biome-ignore ou pulo pelo contexto.
 * O texto (test-hygiene de cada pacote) e o Biome só veem a sintaxe; este reporter vê o que
 * rodou. É o equivalente, nas suítes Vitest, ao scripts/no-disabled-tests-reporter.mjs das
 * suítes node:test da raiz.
 *
 * Uso: `reporters: [...configDefaults.reporters, '../../test-support/vitest-no-disabled-tests-reporter.ts']`
 * (caminho em string) no vitest.config.ts de cada pacote. O test-hygiene de cada pacote fixa
 * essa lista e o script `test` do package.json, e confere o tipo com `const reporter: Reporter`.
 *
 * Lacunas por desenho:
 * - Execução filtrada (-t, arquivo:linha, --tags-filter): o Vitest marca como pulado o que o
 *   filtro deixou de fora, e isso é indistinguível de um pulo declarado. Nela só os testes
 *   selecionados contam (pendente, falha esperada e pulo em tempo de execução). O portão
 *   completo vale na execução sem filtro, a do `pnpm test` e do CI. Filtro na CONFIG
 *   (testNamePattern, tagsFilter) teria o mesmo efeito em toda execução: o test-hygiene de
 *   cada pacote fixa as chaves da config para isso não entrar em silêncio.
 * - `--reporter` na linha de comando SUBSTITUI a lista da config: o portão vale para o script
 *   `test` fixado, não para quem chama o Vitest com outro reporter.
 * - Só o Vitest: os E2E do Playwright (apps/web/e2e) não passam por aqui.
 *
 * Prova: packages/scheduling-core/test/no-disabled-tests-reporter.test.ts, que sobe o Vitest
 * em processo filho sobre sondas (pelo atalho test/support/no-disabled-tests-reporter.ts do
 * core, que reexporta este módulo).
 *
 * Tipos: este arquivo fica fora dos pacotes, onde `vitest` não resolve. Por isso declara só o
 * subconjunto da API de reporters (vitest/node) que lê. A conferência contra os tipos reais
 * acontece no `tsc` de cada pacote: o `new NoDisabledTestsReporter()` em `test.reporters`
 * precisa ser um `Reporter` da versão instalada, e como os ganchos do `Reporter` são
 * propriedades com tipo de função (parâmetros contravariantes), `Vitest`, `TestSpecification`
 * e `TestModule` reais precisam caber nas interfaces abaixo. Campo renomeado, modo ou estado
 * novo no Vitest quebra o typecheck dos três pacotes em vez de passar em silêncio.
 */

/** Modo de coleta de um teste ou suíte (`TaskOptions['mode']`). */
type TaskMode = 'run' | 'only' | 'skip' | 'todo';

/** Estado do resultado de um teste (`TestResult['state']`). */
type TestState = 'pending' | 'passed' | 'failed' | 'skipped';

/** Motivo do fim da execução (`TestRunEndReason`). */
type RunEndReason = 'passed' | 'interrupted' | 'failed';

/** O que o portão lê de `TestCase`. */
interface ReportedTestCase {
  readonly fullName: string;
  readonly options: { readonly mode: TaskMode; readonly fails: boolean | undefined };
  result(): { readonly state: TestState };
}

/** O que o portão lê de `TestSuite`. */
interface ReportedTestSuite {
  readonly fullName: string;
  readonly options: { readonly mode: TaskMode };
  readonly children: ReportedTestCollection;
}

/** O que o portão lê de `TestCollection`. */
interface ReportedTestCollection {
  allTests(): Generator<ReportedTestCase, undefined, void>;
  allSuites(): Generator<ReportedTestSuite, undefined, void>;
}

/** O que o portão lê de `TestModule`. */
interface ReportedTestModule {
  readonly moduleId: string;
  readonly children: ReportedTestCollection;
}

/** O que o portão lê de `TestSpecification` (os filtros por arquivo da execução). */
interface RunSpecification {
  readonly testLines: readonly number[] | undefined;
  readonly testIds: readonly string[] | undefined;
  readonly testNamePattern: RegExp | undefined;
  readonly testTagsFilter: readonly string[] | undefined;
}

/** O que o portão lê de `Vitest`. */
interface VitestContext {
  readonly config: { readonly root: string; readonly tagsFilter?: readonly string[] | undefined };
  readonly logger: { error(message: string): void };
  getGlobalTestNamePattern(): RegExp | undefined;
}

export default class NoDisabledTestsReporter {
  #vitest: VitestContext | undefined;
  #filtered = false;

  onInit(vitest: VitestContext): void {
    this.#vitest = vitest;
  }

  onTestRunStart(specifications: readonly RunSpecification[]): void {
    const vitest = this.#vitest;
    // Mesmo critério do Vitest para "execução parcial" (isPartialRun, no cache de resultados).
    this.#filtered =
      vitest?.getGlobalTestNamePattern() !== undefined ||
      (vitest?.config.tagsFilter?.length ?? 0) > 0 ||
      specifications.some(
        (spec) =>
          (spec.testLines?.length ?? 0) > 0 ||
          spec.testIds !== undefined ||
          spec.testNamePattern !== undefined ||
          (spec.testTagsFilter?.length ?? 0) > 0,
      );
  }

  onTestRunEnd(
    testModules: readonly ReportedTestModule[],
    _errors: unknown,
    reason: RunEndReason,
  ): void {
    // Interrompida (Ctrl+C): o Vitest já sai com erro e o que não rodou aparece como pulado.
    if (reason === 'interrupted') return;

    const root = this.#vitest?.config.root ?? process.cwd();
    const offenders: string[] = [];
    for (const testModule of testModules) {
      const file = path.relative(root, testModule.moduleId);
      for (const testCase of testModule.children.allTests()) {
        const why = this.#disabledTest(testCase);
        if (why !== undefined) offenders.push(`${file} > ${testCase.fullName} [${why}]`);
      }
      for (const suite of testModule.children.allSuites()) {
        const why = this.#disabledEmptySuite(suite);
        if (why !== undefined) offenders.push(`${file} > ${suite.fullName} [${why}]`);
      }
    }
    if (offenders.length === 0) return;

    const lines = [
      '',
      `Testes desligados (${String(offenders.length)}): pulado, pendente ou com falha ` +
        'esperada não verifica nada (regra 3 do CLAUDE.md).',
      ...offenders.map((offender) => `  - ${offender}`),
      'Corrija o teste ou o código e remova a opção ou o modificador.',
      '',
    ];
    if (this.#vitest === undefined) {
      process.stderr.write(`${lines.join('\n')}\n`);
    } else {
      this.#vitest.logger.error(lines.join('\n'));
    }
    process.exitCode = 1;
  }

  #disabledTest(testCase: ReportedTestCase): string | undefined {
    const { mode } = testCase.options;
    // O filtro nunca produz "todo": pendente sempre conta.
    if (mode === 'todo') return 'pendente';
    // Pulado na coleta (opção, modificador, skipIf, tag ou suíte pulada) ou pelo filtro.
    if (mode === 'skip') return this.#filtered ? undefined : 'pulado';
    // Selecionado e pulado ao rodar: pulo pelo contexto do teste, direto ou desestruturado.
    if (testCase.result().state === 'skipped') return 'pulado em execução';
    if (testCase.options.fails === true) return 'falha esperada';
    return undefined;
  }

  /** Suíte pendente ou pulada sem nenhum teste dentro (os testes, se houver, já entram). */
  #disabledEmptySuite(suite: ReportedTestSuite): string | undefined {
    if (suite.children.allTests().next().done !== true) return undefined;
    if (suite.options.mode === 'todo') return 'suíte pendente';
    if (suite.options.mode === 'skip' && !this.#filtered) return 'suíte pulada';
    return undefined;
  }
}
