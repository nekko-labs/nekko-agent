// Setup file for the root vitest.config.ts: run each test file from its own
// package directory, as `npm test -w <pkg>` does. Root Vitest workers start in
// the repo root, and tests that resolve paths against process.cwd() would
// otherwise look in the wrong place. Works in the default `forks` pool.
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    projectRoot: string;
  }
}

process.chdir(inject('projectRoot'));
