import { fc } from '@fast-check/vitest';
import { expect } from 'vitest';
import { temporalEqualityTester } from './support/temporal-equality';

// Os objetos do temporal-polyfill guardam o valor em slots internos: sem este tester,
// toEqual compararia só um cache interno de string, preenchido de forma preguiçosa.
expect.addEqualityTesters([temporalEqualityTester]);

const { CI, FC_NUM_RUNS, FC_PATH, FC_SEED } = process.env;

const numRuns = FC_NUM_RUNS === undefined ? 100 : Number.parseInt(FC_NUM_RUNS, 10);
if (!Number.isSafeInteger(numRuns) || numRuns < 1) {
  throw new RangeError(`FC_NUM_RUNS inválido: ${String(FC_NUM_RUNS)}`);
}

// configureGlobal SUBSTITUI toda a configuração global: declare tudo aqui.
// Reproduzir uma falha: FC_SEED=<seed> FC_PATH=<path> pnpm --filter @salon/scheduling-core test
fc.configureGlobal({
  numRuns,
  ...(FC_SEED === undefined ? {} : { seed: Number.parseInt(FC_SEED, 10) }),
  ...(FC_PATH === undefined ? {} : { path: FC_PATH }),
  ...(CI === undefined ? {} : { interruptAfterTimeLimit: 120_000, markInterruptAsFailure: true }),
});
