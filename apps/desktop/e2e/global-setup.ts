import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build, index, repo } from './paths';

// One renderer bundle for every journey: fixture-app.tsx mounts the scenario
// named in ?scenario=. Built once per run instead of once per harness.
export default async function globalSetup() {
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  await esbuild({
    entryPoints: [join(__dirname, 'fixture-app.tsx')],
    bundle: true,
    jsx: 'automatic',
    conditions: ['style', 'browser', 'import', 'default'],
    format: 'iife',
    outfile: join(build, 'fixture.js'),
    alias: { '@nekko-agent/shared': join(repo, 'packages/shared/src/index.ts') },
    loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' },
    logLevel: 'warning',
  });
  const cssFile = join(build, 'fixture.css');
  const postcss = require('postcss');
  const tailwind = require('@tailwindcss/postcss');
  const css = await postcss([tailwind({ base: repo })]).process(readFileSync(cssFile, 'utf8'), { from: cssFile });
  writeFileSync(join(build, 'styled.css'), css.css);
  writeFileSync(index, '<!doctype html><html data-theme="light"><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'">`
    + '<link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
}
