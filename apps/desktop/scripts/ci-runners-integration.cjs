// Run with Node. Only this worktree's ignored .shots directory is written.
// A new screen: there is no "before" revision to build, so this has no NEKKO_TEST_REVISION mode.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const out = path.join(repo, '.shots/ci-runners');
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const entry = path.join(__dirname, 'ci-runners-fixture.tsx');
  const shared = path.join(repo, 'packages/shared/src/index.ts');
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: repo })]).process(fs.readFileSync(path.join(out, 'fixture.css'), 'utf8'), { from: path.join(out, 'fixture.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_INTEGRATION_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, 'ci-runners-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 180000 });
  if (result.error) throw result.error;
  const evidence = path.join(out, 'after');
  for (const name of fs.readdirSync(evidence)) if (name.startsWith('profile-')) fs.rmSync(path.join(evidence, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  if (result.signal || result.status === null) throw Error(`Electron did not exit cleanly: ${result.signal}`);
  process.exitCode = result.status;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
