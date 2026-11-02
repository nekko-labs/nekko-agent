import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Our own workspace packages must be bundled into the main and preload output,
// never left as runtime requires. They are ESM-only (`"type": "module"` with an
// `exports` map whose only condition is `import`), while main and preload build
// to CJS, so a runtime `require('@nekko-agent/shared')` fails to resolve and Electron
// dies on launch with ERR_PACKAGE_PATH_NOT_EXPORTED. electron-vite 5 externalizes
// every `dependencies` entry by default (`build.externalizeDeps` defaults to
// true, which electron-vite 2 did not do), so each one has to be excluded here.
const workspacePackages = ['@nekko-agent/profile', '@nekko-agent/shared'];

// Writes which npm packages each bundle pulled in, for the notices file
// (scripts/third-party.mjs). The lockfile cannot say: Vite bundles this app's
// devDependencies too, React among them.
function recordBundledPackages(section: string): Plugin {
  const repo = resolve(__dirname, '../..').replace(/\\/g, '/');
  return {
    name: 'record-bundled-packages',
    apply: 'build',
    generateBundle() {
      const dirs = new Set<string>();
      for (const id of this.getModuleIds()) {
        const dir = /^.*node_modules\/(?:@[^/]+\/)?[^/?]+/.exec(id.replace(/\\/g, '/'))?.[0];
        if (dir?.startsWith(`${repo}/`)) dirs.add(dir.slice(repo.length + 1));
      }
      mkdirSync(resolve(__dirname, 'out'), { recursive: true });
      writeFileSync(resolve(__dirname, `out/bundled-packages-${section}.json`), JSON.stringify([...dirs].sort()));
    },
  };
}

export default defineConfig({
  main: {
    plugins: [recordBundledPackages('main')],
    build: {
      // Keep ws bundled as before; native optional helpers remain external below.
      externalizeDeps: { exclude: [...workspacePackages, 'ws'] },
      rollupOptions: {
        // bufferutil and utf-8-validate are `ws`'s optional native helpers, which it
        // loads in a try/catch. Bundled, the missing module became an empty stub
        // and the relay (out/main/relay.js) crashed on the first masked frame;
        // left external, the require throws and ws uses its JS fallback.
        external: ['bufferutil', 'utf-8-validate'],
        // `relay` is apps/relay-server, bundled for "Relay on this computer";
        // nekkod runs it with the app's Electron as Node (local_relay.rs), so
        // it must never import `electron`.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          relay: resolve(__dirname, 'src/relay/relay-main.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [recordBundledPackages('preload')],
    build: {
      externalizeDeps: { exclude: workspacePackages },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // The renderer must bundle exactly one copy of React. zustand is hoisted to
    // the monorepo root, so its `react` peer resolves to the react 18 npm keeps
    // there, while this app renders with its own react 19 - two React instances
    // in one bundle, which leaves the hook dispatcher null and blanks the window
    // with "Cannot read properties of null (reading 'useCallback')". Deduping
    // resolves every `react` import to this app's copy. See bundleExternals.test.ts.
    resolve: { dedupe: ['react', 'react-dom'] },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [react(), recordBundledPackages('renderer'), {
      name: 'preserve-elk-bundle',
      apply: 'build',
      enforce: 'post',
      transform(_code, id) {
        // ELK is already bundled upstream. Walking its generated layout engine
        // for tree shaking dominates build time without removing useful code.
        if (id.replace(/\\/g, '/').includes('/node_modules/elkjs/lib/elk.bundled.js')) {
          return { moduleSideEffects: 'no-treeshake' as const };
        }
      },
    }],
  },
});
