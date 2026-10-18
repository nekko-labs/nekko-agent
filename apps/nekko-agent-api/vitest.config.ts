import { defineConfig } from 'vitest/config';

// The API's own tests. `cloud/` is the parked accounts module, a root
// workspace package with its own dependencies; the root `npm test` runs it.
export default defineConfig({
  test: {
    exclude: ['cloud/**', 'node_modules/**', 'dist/**'],
  },
});
