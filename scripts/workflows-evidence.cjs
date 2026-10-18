// Before/after captures of the Workflows view (gallery, setup, run outcomes, pause): the real WorkflowsView component and
// production CSS in an offscreen, unfocusable Electron window with a throwaway profile and the
// network blocked. "before" builds the renderer and shared package of the merge base, "after" the
// working tree. Data: a fixed snapshot of workflows and runs.
//   node scripts/workflows-evidence.cjs [base revision, default origin/main]
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const repo = path.resolve(__dirname, '..'), out = path.join(repo, '.shots/workflows');
const resolve = (x) => require.resolve(x, { paths: [path.join(repo, 'apps/desktop'), repo] });
const git = (...a) => cp.execFileSync('git', a, { cwd: repo, windowsHide: true, encoding: 'utf8', maxBuffer: 50e6 });
(async () => {
  const base = git('merge-base', process.argv[2] || 'origin/main', 'HEAD').trim();
  const fixture = path.join(__dirname, 'workflows-evidence-fixture.tsx');
  for (const kind of ['before', 'after']) {
    const dir = path.join(out, kind);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let entry = fixture, shared = path.join(repo, 'packages/shared/src/index.ts');
    let renderer = path.join(repo, 'apps/desktop/src/renderer');
    if (kind === 'before') {
      const source = path.join(dir, 'source');
      for (const p of git('ls-tree', '-r', '--name-only', base, 'apps/desktop/src/renderer', 'packages/shared/src').trim().split('\n')) {
        const dest = path.join(source, p);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, cp.execFileSync('git', ['show', `${base}:${p}`], { cwd: repo, windowsHide: true, maxBuffer: 50e6 }));
      }
      entry = path.join(dir, 'fixture.tsx');
      renderer = path.join(source, 'apps/desktop/src/renderer');
      fs.writeFileSync(entry, fs.readFileSync(fixture, 'utf8').replaceAll('../apps/desktop/src/renderer', renderer.replaceAll('\\', '/')));
      shared = path.join(source, 'packages/shared/src/index.ts');
    }
    const modules = path.resolve(path.dirname(resolve('esbuild')), '../..');
    await require(resolve('esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' }, logLevel: 'error' });
    const css = await require(resolve('postcss'))([require(resolve('@tailwindcss/postcss'))({ base: repo })]).process(fs.readFileSync(path.join(dir, 'fixture.css'), 'utf8') + `\n@source "${renderer.replaceAll('\\', '/')}";\n`, { from: path.join(dir, 'fixture.css') });
    fs.writeFileSync(path.join(dir, 'styled.css'), css.css + '\n*,*::before,*::after { animation: none !important; transition: none !important; }');
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body style="margin:0"><div id="root"></div><script src="fixture.js"></script></body></html>`);
    const env = { ...process.env, NEKKO_EVIDENCE_DIR: dir, NEKKO_EVIDENCE_KIND: kind };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = cp.spawnSync(require(resolve('electron')), [path.join(__dirname, 'workflows-evidence-electron.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
    await new Promise((res) => setTimeout(res, 1500));
    for (const name of fs.readdirSync(dir)) if (name.startsWith('profile-')) fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    if (r.error || r.status !== 0) throw r.error || Error(`${kind} Electron exit ${r.status}`);
  }
  console.log(`captures in ${out}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
