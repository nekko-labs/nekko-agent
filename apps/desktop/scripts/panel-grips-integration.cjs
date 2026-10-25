// Run with Node. Captures the Agents wall's side edges (the agent list on the
// left, the Panels dock on the right) and the tray companion on the synthetic
// fixture. Only this worktree's ignored .shots directory is written;
// NEKKO_TEST_REVISION=<rev> captures that revision instead.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const out = path.join(repo, '.shots/panel-grips', process.env.NEKKO_TEST_LABEL || (process.env.NEKKO_TEST_REVISION ? 'before' : 'after'));
async function main() {
  fs.mkdirSync(out, { recursive: true });
  let entry = path.join(__dirname, 'wall-controls-fixture.tsx');
  let sidebar = path.join(__dirname, 'store-sidebar.tsx');
  let shared = path.join(repo, 'packages/shared/src/index.ts');
  let companion = path.join(repo, 'apps/desktop/src/main/trayCompanion.ts');
  if (process.env.NEKKO_TEST_REVISION) {
    const source = path.join(out, 'base-source'); fs.mkdirSync(source, { recursive: true });
    const zip = path.join(out, 'base.zip');
    cp.execFileSync('git', ['archive', '--format=zip', `--output=${zip}`, process.env.NEKKO_TEST_REVISION, 'apps/desktop/src/renderer', 'apps/desktop/src/displayWindows.ts', 'apps/desktop/src/main/trayCompanion.ts', 'packages/shared/src'], { cwd: repo });
    if (process.platform === 'win32') cp.execFileSync('tar', ['-xf', zip, '-C', source]);
    else cp.execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, source]);
    entry = path.join(out, 'base-fixture.tsx');
    fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'wall-controls-fixture.tsx'), 'utf8').replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/')));
    sidebar = path.join(out, 'store-sidebar.tsx');
    fs.writeFileSync(sidebar, fs.readFileSync(path.join(__dirname, 'store-sidebar.tsx'), 'utf8').replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/')));
    shared = path.join(source, 'packages/shared/src/index.ts');
    companion = path.join(source, 'apps/desktop/src/main/trayCompanion.ts');
  }
  const esbuild = require(path.join(modules, 'esbuild'));
  await esbuild.build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared, '@fixture/context': path.join(repo, 'apps/desktop/scripts/fixture-context.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  // The tray companion's page is a pure function of the main process; render it
  // here so the sandbox can load exactly what the app shows.
  await esbuild.build({ entryPoints: [companion], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'companion.cjs'), external: ['electron'], nodePaths: [modules], alias: { '@nekko-agent/shared': shared } });
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: repo })]).process(fs.readFileSync(path.join(out, 'fixture.css'), 'utf8'), { from: path.join(out, 'fixture.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_INTEGRATION_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, path.basename(process.env.NEKKO_PANEL_SANDBOX || 'panel-grips-sandbox.cjs'))], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
