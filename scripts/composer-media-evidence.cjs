// Before/after renderer evidence for the composer's + menu (Photo / Video,
// model-aware), the attachment strip (pasted files, name-only chips) and the
// Mermaid diagram's Expand overlay. Hidden, non-focusable, off-screen Electron
// windows with synthetic data and network blocked; writes only .shots/.
// node scripts/composer-media-evidence.cjs [baseRevision]
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const repo = path.resolve(__dirname, '..'), out = path.join(repo, '.shots/composer-media');
const resolve = (x) => require.resolve(x, { paths: [path.join(repo, 'apps/desktop'), repo] });
const base = process.argv[2] || 'origin/main';
(async () => {
  fs.mkdirSync(out, { recursive: true });
  for (const kind of ['before', 'after']) {
    const dir = path.join(out, kind);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let root = repo;
    if (kind === 'before') {
      root = path.join(dir, 'source');
      for (const p of cp.execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'apps/desktop/src/renderer', 'packages/shared/src', 'packages/core/src'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim().split('\n')) {
        const dest = path.join(root, p);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, cp.execFileSync('git', ['show', `${base}:${p}`], { cwd: repo, windowsHide: true, maxBuffer: 50e6 }));
      }
    }
    const rel = (p) => path.join(root, p).replaceAll('\\', '/');
    const fixture = fs.readFileSync(path.join(__dirname, 'composer-media-evidence-fixture.tsx'), 'utf8')
      .replaceAll('../apps/desktop/src/renderer', rel('apps/desktop/src/renderer'));
    const entry = path.join(dir, 'fixture.tsx');
    fs.writeFileSync(entry, fixture);
    const modules = path.resolve(path.dirname(resolve('esbuild')), '../..');
    await require(resolve('esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': rel('packages/shared/src/index.ts'), '@nekko-agent/core': rel('packages/core/src/index.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' }, logLevel: 'error' });
    const css = await require(resolve('postcss'))([require(resolve('@tailwindcss/postcss'))({ base: repo })]).process(fs.readFileSync(path.join(dir, 'fixture.css'), 'utf8'), { from: path.join(dir, 'fixture.css') });
    fs.writeFileSync(path.join(dir, 'styled.css'), css.css);
    // media-src lets the pending-video <video> show its first frame, as the app's CSP now does.
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' data: blob:; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
    const env = { ...process.env, NEKKO_EVIDENCE_DIR: dir, NEKKO_EVIDENCE_KIND: kind };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = cp.spawnSync(require(resolve('electron')), [path.join(__dirname, 'composer-media-evidence-electron.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 240000 });
    if (r.error) throw r.error;
    console.log(kind, 'exit', r.status);
    fs.rmSync(path.join(dir, 'profile'), { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
    if (kind === 'before') fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
