// Renders the Command Center fixture in a hidden Electron window and measures
// the wall composer's size limits and whether a resize survives leaving the
// page. Set NEKKO_TEST_REVISION=<rev> to run against that revision ("before").
// Writes only to this worktree's ignored .shots directory.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const out = path.join(repo, '.shots/wall-composer-size');
async function main() {
  require('./check-sandbox-syntax.cjs').checkSandboxSyntax(path.join(__dirname, 'wall-composer-size-sandbox.cjs'));
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
  fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'wall-composer-size-fixture.tsx'), 'utf8').replaceAll('../src/renderer', renderer.replaceAll('\\', '/')));
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  const cssSource = fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8');
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: repo })]).process(cssSource, { from: path.join(renderer, 'styles.css') });
  const bundleCss = fs.existsSync(path.join(out, 'fixture.css')) ? fs.readFileSync(path.join(out, 'fixture.css'), 'utf8') : '';
  fs.writeFileSync(path.join(out, 'styled.css'), css.css + '\n' + bundleCss);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body style="margin:0"><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_COMPONENT_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, 'wall-composer-size-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 180000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
