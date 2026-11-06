// NEKKO_TEST_SOURCE=<unchanged-tree> NEKKO_TEST_LABEL=before for the baseline.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const source = process.env.NEKKO_TEST_SOURCE || repo;
const modules = path.join(repo, 'node_modules');
const out = path.join(repo, '.shots/tool-timing', process.env.NEKKO_TEST_LABEL || 'after');
async function main() {
  require('./check-sandbox-syntax.cjs').checkSandboxSyntax(path.join(__dirname, 'tool-timing-sandbox.cjs'));
  fs.mkdirSync(out, { recursive: true });
  const entry = path.join(out, 'fixture.tsx');
  fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'tool-timing-fixture.tsx'), 'utf8').replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer')));
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': path.join(source, 'packages/shared/src/index.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' }, logLevel: 'error' });
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: source })]).process(fs.readFileSync(path.join(out, 'fixture.css'), 'utf8'), { from: path.join(out, 'fixture.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body style="margin:0"><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_COMPONENT_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, 'tool-timing-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
