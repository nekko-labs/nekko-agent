// Produce a self-contained, publishable `nekko-agent` package under cli-dist/:
//   - index.mjs : the server + @nekko-agent/host/core/shared bundled by esbuild
//   - web/      : the built renderer (the UI)
//   - package.json : name "nekko-agent", bin aliases, and the few runtime deps
// Run after building the renderer (npm run build -w @nekko-agent/desktop).
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, packageName } from './nekkod-packages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, '..');
const repoRoot = resolve(serverDir, '../..');
const out = join(serverDir, 'cli-dist');

const renderer = join(repoRoot, 'apps/desktop/out/renderer');
if (!existsSync(join(renderer, 'index.html'))) {
  console.error('Build the renderer first: npm run build -w @nekko-agent/desktop');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Runtime deps stay external (installed by the consumer); everything else inlines.
// node-pty picks its native prebuild with a dynamic require, which an ESM bundle
// cannot do, so it installs as a dependency (the in-process engine's terminals,
// used when nekkod is unavailable; the host loads it either way).
const nodePty = '@lydell/node-pty';
const nodePtyVersion = JSON.parse(readFileSync(join(repoRoot, 'packages/host/package.json'), 'utf8')).dependencies[nodePty];
const external = ['fastify', '@fastify/static', '@fastify/websocket', nodePty];

// The embedded CLI reads its version from `../package.json` beside its own
// module, which inside this single-file bundle would be the consumer's
// node_modules/package.json (and crash at startup). Inline it instead.
const cliVersion = JSON.parse(readFileSync(join(repoRoot, 'apps/cli/package.json'), 'utf8')).version;
const inlineCliVersion = {
  name: 'inline-cli-version',
  setup(b) {
    b.onLoad({ filter: /[\\/]apps[\\/]cli[\\/]dist[\\/]version\.js$/ }, () => ({
      contents: `export const VERSION = ${JSON.stringify(cliVersion)};`,
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: [join(serverDir, 'src/index.ts')],
  outfile: join(out, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  plugins: [inlineCliVersion],
  // A real `require` for the CommonJS modules inlined into this ESM file
  // (@fastify/rate-limit and others require Node built-ins at load).
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __nekkoCreateRequire } from 'node:module';\nconst require = __nekkoCreateRequire(import.meta.url);" },
  logLevel: 'info',
});

cpSync(renderer, join(out, 'web'), { recursive: true });

const version = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')).version;

// The engine daemon. Published installs get it from this platform's
// @nekko-agent/nekkod-* optional dependency (same version, built and published
// by the release workflow). --with-local-nekkod also copies this checkout's
// cargo build into bin/, where the server looks next, to try a packed tarball
// without publishing anything.
const files = ['index.mjs', 'web'];
if (process.argv.includes('--with-local-nekkod')) {
  const exe = process.platform === 'win32' ? 'nekkod.exe' : 'nekkod';
  const built = join(repoRoot, 'target/release', exe);
  if (!existsSync(built)) {
    console.error(`--with-local-nekkod: no ${built}; run cargo build -p nekkod --release --locked first`);
    process.exit(1);
  }
  mkdirSync(join(out, 'bin'), { recursive: true });
  for (const name of readdirSync(dirname(built))) {
    if (name === exe || /^(DirectML\.dll|(lib)?onnxruntime[^/\\]*\.(dll|so(\.\d+)*|dylib))$/.test(name)) cpSync(join(dirname(built), name), join(out, 'bin', name));
  }
  files.push('bin');
}
const pkg = {
  // `nekko-agent` is the thin CLI (apps/cli); this bundle is the self-hosted
  // Local Web UI, a different artifact, so it publishes under its own name.
  name: 'nekko-agent-local-web-ui',
  version,
  description: 'AI help on your computer: the self-hosted Local Web UI plus CLI/MCP. Run with `npx nekko-agent-local-web-ui`.',
  license: 'MIT',
  type: 'module',
  bin: { 'nekko-agent-local-web-ui': 'index.mjs' },
  files,
  engines: { node: '>=20' },
  dependencies: {
    '@fastify/static': '^8.0.3',
    '@fastify/websocket': '^11.0.1',
    fastify: '^5.1.0',
    [nodePty]: nodePtyVersion,
  },
  optionalDependencies: Object.fromEntries(Object.keys(PLATFORMS).map((key) => [packageName(key), version])),
};
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2));
writeFileSync(
  join(out, 'README.md'),
  '# Nekko Agent (Local Web UI + CLI/MCP)\n\nWeb server:\n\n```bash\nnpx nekko-agent-local-web-ui\n```\n\nThen open http://localhost:1440.\n\nCLI / MCP (drive your local agent from the terminal or other tools):\n\n```bash\nnpx nekko-agent-local-web-ui status\nnpx nekko-agent-local-web-ui chat "summarize README.md"\nnpx nekko-agent-local-web-ui mcp        # MCP server on stdio (e.g. claude mcp add nekko-agent -- npx nekko-agent-local-web-ui mcp)\n```\n\nSee https://github.com/nekko-labs/nekko-agent\n',
);

console.log(`\n✓ Bundled publishable package → ${out}`);
console.log('  Test:  cd cli-dist && npm install --omit=dev && node index.mjs');
console.log('  Publish:  cd cli-dist && npm publish');
