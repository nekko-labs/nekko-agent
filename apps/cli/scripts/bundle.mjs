import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, '..');
const dist = resolve(cliDir, 'dist');

mkdirSync(dist, { recursive: true });

const bundleOptions = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // The backend's HTTP server stays a real dependency (package.json), as in the web bundle.
  external: ['@lydell/node-pty', 'fastify', '@fastify/websocket'],
  logLevel: 'info',
};

await Promise.all([
  build({
    ...bundleOptions,
    entryPoints: [resolve(cliDir, 'src/index.ts')],
    outfile: resolve(dist, 'index.js'),
  }),
  build({
    ...bundleOptions,
    entryPoints: [resolve(cliDir, 'src/run.ts')],
    outfile: resolve(dist, 'run.js'),
  }),
  // The engine launcher and backend runner, for nekko-agent-local-web-ui and other embedders.
  ...['engine', 'backend'].map((name) =>
    build({
      ...bundleOptions,
      entryPoints: [resolve(cliDir, `src/${name}.ts`)],
      outfile: resolve(dist, `${name}.js`),
    }),
  ),
]);

writeFileSync(
  resolve(dist, 'run.d.ts'),
  `export declare const EXIT_CODES: {
  readonly success: 0;
  readonly usage: 2;
  readonly notConfigured: 3;
  readonly blocked: 4;
  readonly providerFailure: 5;
  readonly timeout: 6;
  readonly unreachable: 7;
};
export declare class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode?: number);
}
export declare function runCli(argv: string[]): Promise<void>;
`,
);
