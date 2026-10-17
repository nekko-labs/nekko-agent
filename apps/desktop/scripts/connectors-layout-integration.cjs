// Hidden, isolated captures of the Connectors tab layout and brand icons.
// NEKKO_TEST_REVISION=<rev> renders that revision's renderer instead (the "before").
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const out = path.join(repo, '.shots/connectors-layout');
async function main() {
  const base = process.env.NEKKO_TEST_REVISION;
  const work = path.join(out, base ? 'build-before' : 'build-after');
  fs.mkdirSync(work, { recursive: true });
  let source = repo;
  if (base) {
    source = path.join(out, 'base-source'); fs.mkdirSync(source, { recursive: true });
    const tar = cp.execFileSync('git', ['archive', '--format=tar', base, 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo, maxBuffer: 1 << 28, windowsHide: true });
    cp.execFileSync('tar', ['-x', '-C', source], { input: tar, windowsHide: true });
  }
  const renderer = path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/');
  const entry = fs.readFileSync(path.join(__dirname, 'connectors-layout-fixture.tsx'), 'utf8').replaceAll('../src/renderer', renderer);
  fs.writeFileSync(path.join(work, 'entry.tsx'), entry);
  await require('esbuild').build({ entryPoints: [path.join(work, 'entry.tsx')], bundle: true, format: 'iife', jsx: 'automatic', outfile: path.join(work, 'fixture.js'), nodePaths: [path.join(repo, 'node_modules')], alias: { '@nekko-agent/shared': path.join(source, 'packages/shared/src/index.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' }, logLevel: 'error' });
  const css = await require('postcss')([require('@tailwindcss/postcss')({ base: repo })]).process(fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8'), { from: path.join(repo, 'apps/desktop/src/renderer/styles.css') });
  fs.writeFileSync(path.join(work, 'style.css'), css.css);
  fs.writeFileSync(path.join(work, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="setup.js"></script><script src="fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(work, 'setup.js'), `window.nekkoChrome={platform:'win32',titleBarHeight:38,setTitleBarOverlay(){},serviceControl:async()=>({running:true})};`);
  const env = { ...process.env, NEKKO_COMPONENT_OUT: out, NEKKO_COMPONENT_WORK: work }; delete env.ELECTRON_RUN_AS_NODE;
  const child = cp.spawnSync(require('electron'), [path.join(__dirname, 'connectors-layout-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  if (child.error && child.pid && process.platform === 'win32') cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  const profile = path.join(work, 'profile');
  if (profile.startsWith(out + path.sep)) fs.rmSync(profile, { recursive: true, force: true });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
