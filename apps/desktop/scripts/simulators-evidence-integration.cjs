// Run with Node. Builds simulators-evidence-fixture.tsx against this tree, or
// against NEKKO_TEST_REVISION's renderer for the "before" shots, and captures
// it in a hidden, non-focusable, off-screen Electron window (#2814).
// NEKKO_SIM_SHOT names a JPEG for the live view (a real `simctl io screenshot`).
// Only this worktree's ignored .shots directory is written.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const base = process.env.NEKKO_TEST_REVISION;
const out = path.join(repo, '.shots/simulators-evidence', base ? 'before-build' : 'after-build');
const shots = path.join(repo, '.shots/simulators-evidence');
async function main() {
  fs.mkdirSync(out, { recursive: true });
  let fixture = fs.readFileSync(path.join(__dirname, 'simulators-evidence-fixture.tsx'), 'utf8');
  let shared = path.join(repo, 'packages/shared/src/index.ts');
  if (base) {
    const source = path.join(out, 'base-source');
    fs.rmSync(source, { recursive: true, force: true });
    fs.mkdirSync(source, { recursive: true });
    const tar = cp.spawnSync('git', ['archive', base, 'apps/desktop/src', 'packages/shared/src'], { cwd: repo, maxBuffer: 1 << 30 });
    cp.execFileSync('tar', ['-x', '-C', source], { input: tar.stdout });
    // The base has no Simulators.tsx: the status line is simply absent there.
    fixture = fixture.replace(/\/\/ SIMULATOR-STATUS-IMPORT\n.*\n/, 'const SimulatorStatus = (_: any) => null;\n')
      .replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer'))
      .replace("'./monitors-trio-chrome'", JSON.stringify(path.join(__dirname, 'monitors-trio-chrome')));
    shared = path.join(source, 'packages/shared/src/index.ts');
  } else {
    fixture = fixture.replaceAll('../src/renderer', path.join(repo, 'apps/desktop/src/renderer'))
      .replace("'./monitors-trio-chrome'", JSON.stringify(path.join(__dirname, 'monitors-trio-chrome')));
  }
  const entry = path.join(out, 'fixture.tsx');
  fs.writeFileSync(entry, fixture);
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' }, logLevel: 'error' });
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: repo })]).process(fs.readFileSync(path.join(out, 'fixture.css'), 'utf8'), { from: path.join(out, 'fixture.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body style="margin:0"><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_INTEGRATION_OUT: out, NEKKO_SHOTS_OUT: shots }; delete env.ELECTRON_RUN_AS_NODE;
  const r = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, 'simulators-evidence-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 180000 });
  if (r.error) throw r.error;
  process.exitCode = r.status || 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
