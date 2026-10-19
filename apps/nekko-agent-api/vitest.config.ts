import { defineConfig } from 'vitest/config';

// The API's own tests.
export default defineConfig({
  test: {
    exclude: ['node_modules/**', 'dist/**'],
  },
});
