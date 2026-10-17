// Before/after evidence for the work-mode menu: an isolated, hidden, off-screen
// Electron renderer with a synthetic bridge (no host, network or user data).
// `before` renders origin/main's sources at BASE; `after` the working tree.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const repo = path.resolve(__dirname, '..'), out = path.join(repo, '.shots/work-modes');
const BASE = process.env.BASE || 'bd993120';
const resolve = (x) => require.resolve(x, { paths: [path.join(repo, 'apps/desktop'), repo] });
(async () => {
  for (const kind of ['before', 'after']) {
    const dir = path.join(out, kind); fs.mkdirSync(dir, { recursive: true });
    let entry = path.join(__dirname, 'work-modes-evidence-fixture.tsx'), shared = path.join(repo, 'packages/shared/src/index.ts');
    if (kind === 'before') {
      const source = path.join(dir, 'source');
      const files = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', BASE, 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
      for (const p of files) { const dest = path.join(source, p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, cp.execFileSync('git', ['show', `${BASE}:${p}`], { cwd: repo, maxBuffer: 20e6 })); }
      entry = path.join(dir, 'fixture.tsx');
      fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'work-modes-evidence-fixture.tsx'), 'utf8').replaceAll('../apps/desktop/src/renderer', path.join(source, 'apps/desktop/src/renderer')));
      shared = path.join(source, 'packages/shared/src/index.ts');
    }
    const modules = path.resolve(path.dirname(resolve('esbuild')), '../..');
    await require(resolve('esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
    const css = await require(resolve('postcss'))([require(resolve('@tailwindcss/postcss'))({ base: repo })]).process(fs.readFileSync(path.join(dir, 'fixture.css'), 'utf8'), { from: path.join(dir, 'fixture.css') });
    fs.writeFileSync(path.join(dir, 'styled.css'), css.css);
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
    const env = { ...process.env, NEKKO_EVIDENCE_DIR: dir, NEKKO_EVIDENCE_KIND: kind }; delete env.ELECTRON_RUN_AS_NODE;
    const r = cp.spawnSync(require(resolve('electron')), [path.join(__dirname, 'work-modes-evidence-electron.cjs')], { cwd: repo, env, stdio: 'inherit', timeout: 120000 });
    if (r.error) throw r.error;
    for (const name of fs.readdirSync(dir)) if (name.startsWith('profile-')) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    if (r.status) process.exitCode = 1;
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
