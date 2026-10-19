import { configDefaults, defineConfig } from 'vitest/config';

// tsc compiles the tests into dist/ too; run them once, from src/.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'dist/**'] },
});
