const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const repo = path.resolve(__dirname, '..'), out = path.join(repo, '.shots/wall-empty');
const resolve = x => require.resolve(x, { paths: [path.join(repo, 'apps/desktop'), repo] });
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const base = cp.execFileSync('git', ['rev-parse', 'a4d0039b^'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim();
  for (const kind of ['before', 'after']) {
    const dir = path.join(out, kind); fs.mkdirSync(dir, { recursive: true });
    let entry = path.join(__dirname, 'wall-empty-evidence-fixture.tsx'), shared = path.join(repo, 'packages/shared/src/index.ts');
    if (kind === 'before') {
      const source = path.join(dir, 'source');
      const paths = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim().split('\n');
      for (const p of paths) { const dest = path.join(source, p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, cp.execFileSync('git', ['show', `${base}:${p}`], { cwd: repo, windowsHide: true, maxBuffer: 20e6 })); }
      entry = path.join(dir, 'fixture.tsx'); fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'wall-empty-evidence-fixture.tsx'), 'utf8').replaceAll('../apps/desktop/src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/')));
      shared = path.join(source, 'packages/shared/src/index.ts');
    }
    const modules = path.resolve(path.dirname(resolve('esbuild')), '../..');
    const mock = `import React,{useState} from 'react';export function ChatPane(){const [n,setN]=useState(2);window.appendFixture=()=>setN(x=>x+1);return <div className="agent-console" style={{padding:24}}><p>Inspecting the project changes.</p><ul>{Array.from({length:n},(_,i)=><li key={i}><strong>Step {i+1}</strong><span> Streamed analysis and tool result.</span></li>)}</ul></div>} export const TerminalPane=()=>null;`;
    await require(resolve('esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' }, plugins: [{ name: 'mock-pane-bodies', setup(build) { build.onResolve({ filter: /\/(ChatPane|TerminalPane)(\.js)?$/ }, args => ({ path: args.path, namespace: 'mock' })); build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: mock, loader: 'tsx', resolveDir: repo })); } }] });
    const renderer = kind === 'before' ? path.join(dir, 'source/apps/desktop/src/renderer') : path.join(repo, 'apps/desktop/src/renderer');
    const css = await require(resolve('postcss'))([require(resolve('@tailwindcss/postcss'))({ base: repo })]).process(fs.readFileSync(path.join(dir, 'fixture.css'), 'utf8') + `\n@source "${renderer.replaceAll('\\', '/')}";\n`, { from: path.join(dir, 'fixture.css') }); fs.writeFileSync(path.join(dir, 'styled.css'), css.css + '\n/* Static matching captures exclude transient status animation. */\n*,*::before,*::after { animation: none !important; transition: none !important; }');
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
    const env = { ...process.env, NEKKO_EVIDENCE_DIR: dir, NEKKO_EVIDENCE_KIND: kind, NEKKO_EVIDENCE_BASE: base }; delete env.ELECTRON_RUN_AS_NODE;
    const r = cp.spawnSync(require(resolve('electron')), [path.join(__dirname, 'wall-empty-evidence-electron.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
    await new Promise(r => setTimeout(r, 1500));
    for (const name of fs.readdirSync(dir)) if (name.startsWith('profile-')) fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    if (r.error || r.status !== 0) throw r.error || Error(`${kind} Electron exit ${r.status}`);
  }
  const reports = ['before', 'after'].map(k => JSON.parse(fs.readFileSync(path.join(out, k, 'status.json'))));
  const comparisons = reports[0].captures.map(c => ({ name: c.name, identicalPng: fs.readFileSync(path.join(out, 'before', c.name + '.png')).equals(fs.readFileSync(path.join(out, 'after', c.name + '.png'))) }));
  fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify({ reports, comparisons, parentPixelInspectionRequired: true }, null, 2));
  fs.writeFileSync(path.join(out, 'review.html'), `<!doctype html><meta charset="utf-8"><title>Wall empty evidence</title><style>body{font:14px system-ui;background:#eee;margin:24px}section{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px}img{width:100%;border:1px solid #888}h2{grid-column:1/-1}</style><h1>CommandWall: ${base} / working source</h1><p>Actual React CommandWall and production CSS. Mock pane bodies only. Fixture disables animations/transitions for deterministic static comparison; motion behavior is not validated. Offscreen nonfocusable Electron, disposable profile, network blocked. Parent pixel inspection required. No native chrome proof; no performance trace measured. No motion capture because appearance and scroll timing are expected unchanged.</p>${comparisons.map(c => `<section><h2>${c.name}, identical PNG: ${c.identicalPng}</h2><div>Before<img src="before/${c.name}.png"></div><div>After<img src="after/${c.name}.png"></div></section>`).join('')}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
