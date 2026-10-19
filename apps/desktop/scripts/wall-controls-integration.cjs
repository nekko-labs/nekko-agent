// Run with Node. Only this worktree's ignored .shots directory is written.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const out = path.join(repo, '.shots/wall-controls-integration');
if (process.argv.includes('--grid-bugs')) process.env.NEKKO_GRID_BUGS = '1';
async function main() {
  fs.mkdirSync(out, { recursive: true });
  let entry = path.join(__dirname, 'wall-controls-fixture.tsx');
  let shared = path.join(repo, 'packages/shared/src/index.ts');
  if (process.env.NEKKO_TEST_REVISION) {
    const source = path.join(out, 'base-source'); fs.mkdirSync(source, { recursive: true });
    const zip = path.join(out, 'base.zip');
    cp.execFileSync('git', ['archive', '--format=zip', `--output=${zip}`, process.env.NEKKO_TEST_REVISION, 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo });
    // Windows has bsdtar (which reads zip) but often no python3.
    if (process.platform === 'win32') cp.execFileSync('tar', ['-xf', zip, '-C', source]);
    else cp.execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, source]);
    entry = path.join(out, 'base-fixture.tsx');
    fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'wall-controls-fixture.tsx'), 'utf8').replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/')));
    shared = path.join(source, 'packages/shared/src/index.ts');
  }
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared, '@fixture/context': path.join(repo, 'apps/desktop/scripts/fixture-context.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: repo })]).process(fs.readFileSync(path.join(out, 'fixture.css'), 'utf8'), { from: path.join(out, 'fixture.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  if (process.env.NEKKO_LAYOUT_FIXES || process.env.NEKKO_VIEW_CHROME) {
    fs.writeFileSync(path.join(out, 'chrome-bootstrap.js'), "window.nekkoChrome={platform:'win32',titleBarHeight:32,setTitleBarOverlay:()=>{},serviceControl:async()=>null}");
    const html=path.join(out,'index.html'); fs.writeFileSync(html,fs.readFileSync(html,'utf8').replace('<script src="fixture.js">','<script src="chrome-bootstrap.js"></script><script src="fixture.js">'));
  }
  const env = { ...process.env, NEKKO_INTEGRATION_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, 'wall-controls-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
