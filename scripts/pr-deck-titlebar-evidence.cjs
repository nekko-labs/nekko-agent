// Before/after evidence for the upward PR deck and the shorter title strip.
// Real TitleBar, PrActionDock and production CSS; inert bridge; hidden,
// offscreen, non-focusable Electron with a throwaway profile and no network.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const repo = path.resolve(__dirname, '..'), out = path.join(repo, '.shots/pr-deck-titlebar');
const resolve = x => require.resolve(x, { paths: [path.join(repo, 'apps/desktop'), repo] });
const base = process.env.NEKKO_EVIDENCE_BASE || 'origin/main';
(async () => {
  fs.rmSync(out, { recursive: true, force: true });
  const baseSha = cp.execFileSync('git', ['rev-parse', base], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  for (const kind of ['before', 'after']) {
    const dir = path.join(out, kind); fs.mkdirSync(dir, { recursive: true });
    let src = repo;
    if (kind === 'before') {
      src = path.join(dir, 'source');
      const files = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', baseSha, 'apps/desktop/src', 'packages/shared/src'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim().split('\n');
      for (const f of files) { const d = path.join(src, f); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, cp.execFileSync('git', ['show', `${baseSha}:${f}`], { cwd: repo, windowsHide: true, maxBuffer: 50e6 })); }
    }
    const fwd = p => p.replaceAll('\\', '/');
    const entry = path.join(dir, 'fixture.tsx');
    fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'pr-deck-titlebar-evidence-fixture.tsx'), 'utf8')
      .replaceAll('../apps/desktop/src/renderer', fwd(path.join(src, 'apps/desktop/src/renderer')))
      .replace("'./pr-deck-titlebar-evidence-setup'", JSON.stringify(fwd(path.join(__dirname, 'pr-deck-titlebar-evidence-setup.ts'))))
      .replace("(window as any).EVIDENCE_KIND === 'after'", String(kind === 'after')));
    const modules = path.resolve(path.dirname(resolve('esbuild')), '../..');
    await require(resolve('esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': path.join(src, 'packages/shared/src/index.ts') }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' }, logLevel: 'error' });
    const css = await require(resolve('postcss'))([require(resolve('@tailwindcss/postcss'))({ base: repo })]).process(fs.readFileSync(path.join(dir, 'fixture.css'), 'utf8') + `\n@source "${fwd(path.join(src, 'apps/desktop/src/renderer'))}";\n@source "${fwd(entry)}";\n`, { from: path.join(dir, 'fixture.css') });
    fs.writeFileSync(path.join(dir, 'styled.css'), css.css);
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body style="margin:0"><div id="root"></div><script src="fixture.js"></script></body></html>`);
    const env = { ...process.env, NEKKO_EVIDENCE_DIR: dir, NEKKO_EVIDENCE_KIND: kind }; delete env.ELECTRON_RUN_AS_NODE;
    const r = cp.spawnSync(require(resolve('electron')), [path.join(__dirname, 'pr-deck-titlebar-evidence-electron.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
    await new Promise(res => setTimeout(res, 1200));
    for (const n of fs.readdirSync(dir)) if (n.startsWith('profile-')) fs.rmSync(path.join(dir, n), { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    if (r.error || r.status !== 0) throw r.error || Error(`${kind} Electron exit ${r.status}`);
  }
  console.log('base', baseSha, '->', out);
})().catch(e => { console.error(e); process.exitCode = 1; });
