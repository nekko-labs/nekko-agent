// Renders the Model server card with a broken Windows CUDA engine in a hidden
// Electron window and captures it. Set NEKKO_TEST_REVISION=<rev> to render that
// revision's card ("before"); the fixture data is the same either way.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const out = path.join(repo, '.shots/engine-repair');
async function main() {
  require('./check-sandbox-syntax.cjs').checkSandboxSyntax(path.join(__dirname, 'engine-repair-sandbox.cjs'));
  fs.mkdirSync(out, { recursive: true });
  let renderer = path.join(repo, 'apps/desktop/src/renderer');
  let shared = path.join(repo, 'packages/shared/src/index.ts');
  if (process.env.NEKKO_TEST_REVISION) {
    const source = path.join(out, 'base-source');
    fs.rmSync(source, { recursive: true, force: true });
    fs.mkdirSync(source, { recursive: true });
    const tar = cp.execFileSync('git', ['archive', '--format=tar', process.env.NEKKO_TEST_REVISION, 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo, maxBuffer: 1 << 30 });
    cp.execFileSync('tar', ['-x', '-C', source], { input: tar });
    renderer = path.join(source, 'apps/desktop/src/renderer');
    shared = path.join(source, 'packages/shared/src/index.ts');
  }
  const entry = path.join(out, 'fixture-entry.tsx');
  fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'engine-repair-fixture.tsx'), 'utf8').replaceAll('../src/renderer', renderer.replaceAll('\\', '/')));
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  const cssSource = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/styles.css'), 'utf8');
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: repo })]).process(cssSource, { from: path.join(repo, 'apps/desktop/src/renderer/styles.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css + '\n.fixture-shell{min-height:100vh;background:var(--bg);color:var(--ink);font:14px system-ui}.fixture-shell main{padding:24px}');
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_COMPONENT_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, 'engine-repair-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
