import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Root `npm test` runs every workspace's Vitest suite in one process and one
// worker pool instead of eight sequential `vitest run`s. Each project keeps its
// package as root, so include/exclude, tsconfig (desktop's JSX) and the
// package's own vitest.config.ts (shared and cli exclude dist/) apply exactly
// as under `npm test -w <pkg>`, which still works on its own.
// apps/mobile and apps/nekko-agent-api keep their own runners and are not part of root
// `npm test`.
const packages = ['packages/shared', 'packages/core', 'apps/desktop', 'apps/nekko-agent-api/cloud', 'packages/host', 'apps/local-web-ui', 'apps/relay-server', 'apps/cli'];
const withConfig = new Set(['packages/shared', 'apps/cli']);
const cwdSetup = fileURLToPath(new URL('./scripts/vitest-project-cwd.ts', import.meta.url));

export default defineConfig({
  test: {
    projects: packages.map(dir => ({
      // Inline projects otherwise extend this file; point them at the
      // package's own config where it has one, and nothing else where not.
      extends: withConfig.has(dir) ? `./${dir}/vitest.config.ts` : false,
      root: dir,
      test: {
        name: dir,
        // Tests that resolve paths against process.cwd() (host's esbuild
        // fixtures, for one) expect the package directory, as under npm -w.
        setupFiles: [cwdSetup],
        provide: { projectRoot: fileURLToPath(new URL(`./${dir}/`, import.meta.url)) },
      },
    })),
  },
});
