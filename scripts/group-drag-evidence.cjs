const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const repo = path.resolve(__dirname, '..'), out = path.join(repo, '.shots/group-drag');
const resolve = x => require.resolve(x, { paths: [path.join(repo, 'apps/desktop'), repo] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(out, { recursive: true });
  for (const kind of ['before', 'after']) {
    if (kind === 'after') {
      const deadline = Date.now() + 10 * 60 * 1000;
      while (!fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/components/commandWallLayouts.css'), 'utf8').includes('.agent-panel-group-gap')) {
        if (Date.now() > deadline) throw Error('Timed out waiting for parent group-gap CSS');
        console.log('Waiting for parent .agent-panel-group-gap CSS'); await sleep(3000);
      }
    }
    const dir = path.join(out, kind); fs.mkdirSync(dir, { recursive: true });
    let entry = path.join(__dirname, 'group-drag-evidence-fixture.tsx'), shared = path.join(repo, 'packages/shared/src/index.ts');
    if (kind === 'before') {
      const source = path.join(dir, 'source');
      const paths = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', '76c2db7b', 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim().split('\n');
      for (const p of paths) { const dest = path.join(source, p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, cp.execFileSync('git', ['show', `76c2db7b:${p}`], { cwd: repo, windowsHide: true, maxBuffer: 20e6 })); }
      entry = path.join(dir, 'fixture.tsx'); fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'group-drag-evidence-fixture.tsx'), 'utf8').replaceAll('../apps/desktop/src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/')));
      shared = path.join(source, 'packages/shared/src/index.ts');
    }
    const modules = path.resolve(path.dirname(resolve('esbuild')), '../..');
    await require(resolve('esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
    const renderer = kind === 'before' ? path.join(dir, 'source/apps/desktop/src/renderer') : path.join(repo, 'apps/desktop/src/renderer');
    const inputCss = fs.readFileSync(path.join(dir, 'fixture.css'), 'utf8') + `\n@source "${renderer.replaceAll('\\\\', '/')}";\n`;
    const css = await require(resolve('postcss'))([require(resolve('@tailwindcss/postcss'))({ base: repo })]).process(inputCss, { from: path.join(dir, 'fixture.css') }); fs.writeFileSync(path.join(dir, 'styled.css'), css.css);
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
    const env = { ...process.env, NEKKO_EVIDENCE_DIR: dir, NEKKO_EVIDENCE_KIND: kind }; delete env.ELECTRON_RUN_AS_NODE;
    const r = cp.spawnSync(require(resolve('electron')), [path.join(__dirname, 'group-drag-evidence-electron.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 240000 });
    await sleep(1500);
    for (const name of fs.readdirSync(dir)) if (name.startsWith('profile-')) fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    if (r.error || r.status !== 0) throw r.error || Error(`${kind} Electron exit ${r.status}`);
  }
  const reports = ['before', 'after'].map(k => JSON.parse(fs.readFileSync(path.join(out, k, 'status.json'))));
  fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify({ reports, parentPixelInspectionRequired: true }, null, 2));
  const names = reports[0].captures.map(c => c.name);
  fs.writeFileSync(path.join(out, 'review.html'), `<!doctype html><meta charset="utf-8"><title>Group drag evidence review</title><style>body{font:14px system-ui;background:#eee;color:#222;margin:24px}section{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:32px}img,video{width:100%;border:1px solid #888}h2{grid-column:1/-1}pre{white-space:pre-wrap}</style><h1>Group drag: 76c2db7b / working source</h1><p>Actual React WorkspacesView sidebarOnly. Hidden, off-screen, nonfocusable Electron. Mock API and disposable profile. DOM-synthetic drag events, not OS input. Parent must inspect screenshot pixels and motion. No native window chrome or physical drag validation.</p>${names.map(n => `<section><h2>${n}</h2><div>Before<img src="before/${n}.png"></div><div>After<img src="after/${n}.png"></div></section>`).join('')}<section><h2>Drag timing (DOM-synthetic)</h2><video controls src="before/group-drag-motion.mp4"></video><video controls src="after/group-drag-motion.mp4"></video></section><pre>${JSON.stringify(reports.map(r => ({ kind: r.kind, checks: r.checks, errors: r.errors, background: r.background })), null, 2)}</pre>`);
})().catch(e => { console.error(e); process.exitCode = 1; });
