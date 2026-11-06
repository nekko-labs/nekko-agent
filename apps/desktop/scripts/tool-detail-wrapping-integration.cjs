// Real detail components in the existing hidden Electron component fixture.
// Capture the unchanged revision first, then current source:
// NEKKO_TEST_REVISION=<base-sha> node apps/desktop/scripts/tool-detail-wrapping-integration.cjs
// node apps/desktop/scripts/tool-detail-wrapping-integration.cjs
// Inspect the PNGs separately; successful layout checks are not pixel inspection.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const out = path.join(repo, '.shots/tool-detail-wrapping');
async function main() {
  require('./check-sandbox-syntax.cjs').checkSandboxSyntax(path.join(__dirname, 'tool-detail-wrapping-sandbox.cjs'));
  fs.mkdirSync(out, { recursive: true });
  let entry = path.join(__dirname, 'tool-detail-wrapping-fixture.tsx');
  let shared = path.join(repo, 'packages/shared/src/index.ts');
  if (process.env.NEKKO_TEST_REVISION) {
    const revision = cp.execFileSync('git', ['rev-parse', process.env.NEKKO_TEST_REVISION], { cwd: repo, encoding: 'utf8' }).trim();
    const source = path.join(out, 'base-source', revision);
    if (!fs.existsSync(source)) {
      fs.mkdirSync(source, { recursive: true });
      const zip = path.join(out, 'base.zip');
      cp.execFileSync('git', ['archive', '--format=zip', `--output=${zip}`, process.env.NEKKO_TEST_REVISION, 'apps/desktop/src', 'packages/shared/src'], { cwd: repo });
      cp.execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, source]);
    }
    entry = path.join(out, 'base-fixture.tsx');
    fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'tool-detail-wrapping-fixture.tsx'), 'utf8').replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/')).replace(/^import .*styles\.css';\r?\n/m, ''));
    shared = path.join(source, 'packages/shared/src/index.ts');
  }
  if (!process.env.NEKKO_TEST_REVISION) {
    entry = path.join(out, 'current-fixture.tsx');
    fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'tool-detail-wrapping-fixture.tsx'), 'utf8').replaceAll('../src/renderer', path.join(repo, 'apps/desktop/src/renderer').replaceAll('\\', '/')).replace(/^import .*styles\.css';\r?\n/m, ''));
  }
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  const cssSource = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/styles.css'), 'utf8');
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: repo })]).process(cssSource, { from: path.join(repo, 'apps/desktop/src/renderer/styles.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css + '\n.fixture-shell{min-height:100vh;background:var(--bg);color:var(--ink);font:14px system-ui}.fixture-shell header{padding:16px 24px;border-bottom:1px solid var(--line);font-weight:700}.fixture-shell header span{font-size:12px;color:var(--ink-faint);font-weight:400;margin-left:16px}.fixture-shell main{max-width:760px;padding:32px 24px;margin:0 auto}.fixture-label{color:var(--ink-faint);font-size:11px;text-transform:uppercase;letter-spacing:.1em;margin:24px 0 8px}');
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_COMPONENT_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const electron = path.join(modules, 'electron');
  const result = cp.spawnSync(require(electron), [path.join(__dirname, 'tool-detail-wrapping-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
