// Run with Node. Builds the Agent Monitor minimize fixture (current tree, or
// NEKKO_TEST_REVISION for the "before" shots) and captures it in a hidden,
// isolated Electron window. Only this worktree's ignored .shots directory is written.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const base = process.env.NEKKO_TEST_REVISION;
const out = path.join(repo, '.shots/monitor-minimize', base ? 'before-build' : 'after-build');
const shots = path.join(repo, '.shots/monitor-minimize');
async function main() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  let renderer = path.join(repo, 'apps/desktop/src/renderer');
  let shared = path.join(repo, 'packages/shared/src/index.ts');
  if (base) {
    const source = path.join(out, 'base-source'); fs.mkdirSync(source, { recursive: true });
    const tar = path.join(out, 'base.tar');
    cp.execFileSync('git', ['archive', '--format=tar', `--output=${tar}`, base, 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo, windowsHide: true });
    cp.execFileSync('tar', ['-xf', tar, '-C', source], { windowsHide: true });
    renderer = path.join(source, 'apps/desktop/src/renderer');
    shared = path.join(source, 'packages/shared/src/index.ts');
  }
  const entry = path.join(out, 'fixture.tsx');
  fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'monitor-minimize-fixture.tsx'), 'utf8')
    .replaceAll('../src/renderer', renderer.replaceAll('\\', '/'))
    .replaceAll('__BASE__', base ? 'true' : 'false'));
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: path.dirname(renderer) })]).process(fs.readFileSync(path.join(out, 'fixture.css'), 'utf8'), { from: path.join(out, 'fixture.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_INTEGRATION_OUT: out, NEKKO_SHOTS_OUT: shots }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, 'monitor-minimize-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
