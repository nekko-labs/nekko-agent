// Run with Node. Only this worktree's ignored .shots directory is written.
// NEKKO_TEST_REVISION=main captures the unchanged header for a before shot.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const out = path.join(repo, '.shots/chat-finder');
async function main() {
  fs.mkdirSync(out, { recursive: true });
  let entry = path.join(__dirname, 'chat-finder-fixture.tsx');
  let shared = path.join(repo, 'packages/shared/src/index.ts');
  if (process.env.NEKKO_TEST_REVISION) {
    const source = path.join(out, 'base-source'); fs.rmSync(source, { recursive: true, force: true }); fs.mkdirSync(source, { recursive: true });
    const tar = cp.execFileSync('git', ['archive', '--format=tar', process.env.NEKKO_TEST_REVISION, 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo, maxBuffer: 1 << 30 });
    cp.execFileSync('tar', ['-x', '-C', source], { input: tar });
    entry = path.join(out, 'base-fixture.tsx');
    fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'chat-finder-fixture.tsx'), 'utf8').replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/')));
    shared = path.join(source, 'packages/shared/src/index.ts');
  }
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: repo })]).process(fs.readFileSync(path.join(out, 'fixture.css'), 'utf8'), { from: path.join(out, 'fixture.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_INTEGRATION_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, 'chat-finder-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
