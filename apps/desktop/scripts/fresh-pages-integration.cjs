const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const out = path.join(repo, '.shots/fresh-pages');
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const base = process.env.NEKKO_TEST_REVISION;
  let source = repo;
  if (base) {
    source = path.join(out, 'base-source'); fs.mkdirSync(source, { recursive: true });
    const tar = cp.execFileSync('git', ['archive', '--format=tar', base, 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo, maxBuffer: 1 << 28, windowsHide: true });
    cp.execFileSync('tar', ['-x', '-C', source], { input: tar, windowsHide: true });
  }
  const renderer = path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/');
  const defaults = JSON.parse(fs.readFileSync(path.join(repo, 'crates/nekko-settings/src/defaults.json'), 'utf8')).defaults;
  const entry = fs.readFileSync(path.join(__dirname, 'fresh-pages-fixture.tsx'), 'utf8').replaceAll('../src/renderer', renderer)
    .replace('__DEFAULTS__', JSON.stringify(defaults))
    .replace('__BOUNDARY_IMPORT__', base ? 'const Boundary = ({children}: any) => <>{children}</>;' : `import { ErrorBoundary as Boundary } from '${renderer}/components/ErrorBoundary';`);
  fs.writeFileSync(path.join(out, 'entry.tsx'), entry);
  await require('esbuild').build({ entryPoints: [path.join(out, 'entry.tsx')], bundle: true, format: 'iife', jsx: 'automatic', outfile: path.join(out, 'fixture.js'), nodePaths: [path.join(repo, 'node_modules')], alias: { '@nekko-agent/shared': path.join(source, 'packages/shared/src/index.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  const css = await require('postcss')([require('@tailwindcss/postcss')({ base: repo })]).process(fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8'), { from: path.join(repo, 'apps/desktop/src/renderer/styles.css') });
  fs.writeFileSync(path.join(out, 'style.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="setup.js"></script><script src="fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(out, 'setup.js'), `window.nekkoChrome={platform:'win32',titleBarHeight:38,setTitleBarOverlay(){},serviceControl:async()=>({running:true})};`);
  const env = { ...process.env, NEKKO_COMPONENT_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const child = cp.spawnSync(require('electron'), [path.join(__dirname, 'fresh-pages-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  if (child.error && child.pid && process.platform === 'win32') cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  const profile = path.join(out, base ? 'before' : 'after', 'profile');
  if (profile.startsWith(out + path.sep)) fs.rmSync(profile, { recursive: true, force: true });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
