// Builds tool-hover-fixture.tsx (optionally against another revision's
// renderer via NEKKO_TEST_SOURCE) and captures it in a hidden, off-screen,
// non-focusable window. Writes only to this worktree's ignored .shots dir.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const label = process.env.NEKKO_TEST_LABEL || 'head';
const out = path.join(repo, '.shots/layout-evidence', label);
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const source = process.env.NEKKO_TEST_SOURCE || repo;
  let entry = path.join(__dirname, 'tool-hover-fixture.tsx');
  if (source !== repo) {
    entry = path.join(out, 'fixture.tsx');
    fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'tool-hover-fixture.tsx'), 'utf8').replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer')));
  }
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': path.join(source, 'packages/shared/src/index.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' }, logLevel: 'error' });
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: source })]).process(fs.readFileSync(path.join(out, 'fixture.css'), 'utf8'), { from: path.join(out, 'fixture.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body style="margin:0;height:100vh"><div id="root" style="height:100%"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_INTEGRATION_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  // NEKKO_LAYOUT_SANDBOX picks another capture script for the same fixture.
  const sandbox = path.join(__dirname, path.basename(process.env.NEKKO_LAYOUT_SANDBOX || 'tool-hover-sandbox.cjs'));
  const r = cp.spawnSync(require(path.join(modules, 'electron')), [sandbox], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  if (r.error) throw r.error;
  process.exitCode = r.status || 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
