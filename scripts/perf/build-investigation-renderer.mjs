// Diagnostic build only. Never writes production output or installs primary dependencies.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const deps = resolve(process.argv[2] ?? root);
const out = resolve(process.argv[3] ?? '.shots/perf-investigation/current-renderer');
const require = createRequire(join(deps, 'package.json'));
const esbuild = require('esbuild');
mkdirSync(out, { recursive: true });
const renderer = join(root, 'apps/desktop/src/renderer');
await esbuild.build({ entryPoints: [join(renderer, 'main.tsx')], bundle: true, minify: true, sourcemap: true,
  jsx: 'automatic', format: 'esm', splitting: true, outdir: out, nodePaths: [join(root, '.shots/perf-investigation/deps/node_modules'), join(deps, 'apps/desktop/node_modules'), join(deps, 'node_modules')],
  alias: { '@nekko-agent/shared': join(root, 'packages/shared/src/index.ts') },
  conditions: ['style', 'browser', 'import', 'default'], loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
});
const cssFile = join(out, 'main.css');
const cssRequire = createRequire(join(root, '.shots/perf-investigation/deps/package.json'));
const css = await cssRequire('postcss')([cssRequire('@tailwindcss/postcss')({ base: deps })]).process(
  readFileSync(cssFile, 'utf8') + `\n@source "${renderer.replaceAll('\\', '/')}";\n`, { from: join(deps, 'investigation.css') });
writeFileSync(cssFile, css.css);
writeFileSync(join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="main.css"></head><body><div id="root"></div><script type="module" src="main.js"></script></body></html>');
writeFileSync(join(out, 'build-provenance.json'), JSON.stringify({ sourceRoot: root, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), dependencyRoot: deps, build: 'diagnostic esbuild production main.tsx + Tailwind; not electron-vite release build', at: new Date().toISOString() }, null, 2));
console.log(out);
