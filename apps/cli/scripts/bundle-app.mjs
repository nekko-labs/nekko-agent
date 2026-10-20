// Produce the copy of the CLI that ships *inside* the desktop app.
//
// Different artifact from scripts/bundle.mjs (which builds the publishable npm
// package): CommonJS, because the app runs it through its own Electron binary
// with ELECTRON_RUN_AS_NODE=1. That means the CLI works on a machine with no
// Node and no npm at all, which is the whole point of shipping it.
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, '..');
const out = resolve(cliDir, 'app-dist');

mkdirSync(out, { recursive: true });

// src/version.ts reads ../package.json beside itself at runtime, which is fine
// in the npm package and wrong here: inside the app there is no package.json
// next to the bundle, and CommonJS has no import.meta to resolve it from. The
// version is known now, so it is baked in.
const { version } = JSON.parse(readFileSync(resolve(cliDir, 'package.json'), 'utf8'));
const inlineVersion = {
  name: 'inline-version',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]version\.ts$/ }, () => ({
      contents: `export const VERSION = ${JSON.stringify(version)};\n`,
      loader: 'ts',
    }));
  },
};

await build({
  entryPoints: [resolve(cliDir, 'src/index.ts')],
  outfile: resolve(out, 'nekko-agent-cli.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  plugins: [inlineVersion],
  logLevel: 'info',
});

console.log(`\n✓ Bundled the in-app CLI → ${out}/nekko-agent-cli.cjs`);
