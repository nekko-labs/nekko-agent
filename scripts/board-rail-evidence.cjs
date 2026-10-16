const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const repo = path.resolve(__dirname, '..'), primary = path.resolve(repo, '../..'), out = path.join(repo, '.shots/board-rail');
const resolve = x => require.resolve(x, { paths: [path.join(primary, 'apps/desktop'), primary, path.join(repo, 'apps/desktop'), repo] });
const git = args => cp.execFileSync('git', args, { cwd: repo, windowsHide: true, maxBuffer: 30e6 });
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const base = process.env.NEKKO_EVIDENCE_BASE || '5761e0a1';
  const kinds = process.env.NEKKO_EVIDENCE_ONLY ? [process.env.NEKKO_EVIDENCE_ONLY] : ['before', 'after'];
  for (const kind of kinds) {
    const dir = path.join(out, kind), source = path.join(dir, 'source'); fs.mkdirSync(source, { recursive: true });
    const paths = git(['ls-tree', '-r', '--name-only', base, 'apps/desktop/src/renderer', 'packages/shared/src']).toString().trim().split('\n');
    const hashes = {};
    for (const p of paths) {
      const bytes = kind === 'before' ? git(['show', `${base}:${p}`]) : fs.readFileSync(path.join(repo, p));
      const dest = path.join(source, p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes); hashes[p] = crypto.createHash('sha256').update(bytes).digest('hex');
    }
    const renderer = path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/');
    const app = fs.readFileSync(path.join(renderer, 'App.tsx'), 'utf8');
    const nav = app.slice(app.indexOf('<nav className='), app.indexOf('</nav>') + 6);
    const mobileStart = app.indexOf('<nav', app.indexOf('</nav>') + 6), mobile = app.slice(mobileStart, app.indexOf('</nav>', mobileStart) + 6);
    if (!nav.includes('visibleNav.map') || !mobile.includes('mobileNav.map')) throw Error('App nav extraction boundary changed');
    const icons = app.slice(app.lastIndexOf('import {', app.indexOf("from './navIcons.js';")), app.indexOf("from './navIcons.js';") + "from './navIcons.js';".length).replace("'./navIcons.js'", `'${renderer}/navIcons.js'`);
    const defs = app.slice(app.indexOf('const AgentCatIcon'), app.indexOf('export function App()')).replaceAll(': View[]', ': any[]').replace('Array<{ view: View;', 'Array<{ view: any;');
    const setup = `const view='command', t=(k:string)=>({ 'nav.command':'Agents','nav.chat':'Workspace','nav.modelserver':'Model Server' }[k] || k.replace('nav.','').replace(/^./,c=>c.toUpperCase())); const visibleNav=NAV; const mobileNav=MOBILE_NAV; const [draggedNav,setDraggedNav]=useState<any>(null),[dropNav,setDropNav]=useState<any>(null); const reorder=async()=>{};const setView=()=>{};`;
    fs.writeFileSync(path.join(dir, 'nav.tsx'), `import React,{useState} from 'react'; import {NekkoAvatar} from '${renderer}/components/Mascot'; import {RailBackdrop} from '${renderer}/components/RailBackdrop'; import {BrandMark} from '${renderer}/components/BrandMark'; import {hasAppChrome} from '${renderer}/chrome'; ${icons}\n${defs}\nexport function EvidenceNav(){${setup}return (${nav});}\nexport function EvidenceMobileNav(){${setup}return (${mobile});}`);
    const fixture = fs.readFileSync(path.join(__dirname, 'board-rail-evidence-fixture.tsx'), 'utf8').replaceAll('../apps/desktop/src/renderer', renderer).replace('./board-rail-evidence-nav', './nav');
    fs.writeFileSync(path.join(dir, 'fixture.tsx'), fixture);
    const mock = path.join(dir, 'pane.tsx'); fs.writeFileSync(mock, `import React from 'react';const Pane=()=> <div className="h-full bg-paper p-4 text-ink-faint" data-fixture-pane>Offline agent pane<br/>Stable fixture content, no host or network.</div>; export {Pane as ChatPane,Pane as TerminalPane,Pane as FilePane,Pane as ExplorerPane,Pane as BrowserPane,Pane as DiffPane};`);
    await require(resolve('esbuild')).build({ entryPoints: [path.join(dir, 'fixture.tsx')], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [path.join(primary, 'node_modules'), path.join(primary, 'apps/desktop/node_modules')], alias: { '@nekko-agent/shared': path.join(source, 'packages/shared/src/index.ts') }, plugins: [{ name: 'offline-panes', setup(b) { b.onResolve({ filter: /\/(ChatPane|TerminalPane|FilePane|ExplorerPane|BrowserPane|DiffPane)(\.js)?$/ }, () => ({ path: mock })); } }], loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
    const input = fs.readFileSync(path.join(dir, 'fixture.css'), 'utf8').replace('@tailwind utilities;', '@tailwind utilities source(none);') + `\n@source "${renderer}/**/*.{ts,tsx}";\n@source "${dir.replaceAll('\\', '/') }/*.tsx";`;
    const css = await require(resolve('postcss'))([require(resolve('@tailwindcss/postcss'))({ base: primary })]).process(input, { from: path.join(dir, 'fixture.css') }); fs.writeFileSync(path.join(dir, 'styled.css'), css.css);
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
    fs.writeFileSync(path.join(dir, 'source-manifest.json'), JSON.stringify({ base, kind, head: git(['rev-parse', 'HEAD']).toString().trim(), hashes }, null, 2));
    if (process.env.NEKKO_EVIDENCE_BUILD_ONLY) continue;
    const env = { ...process.env, NEKKO_EVIDENCE_DIR: dir, NEKKO_EVIDENCE_KIND: kind }; delete env.ELECTRON_RUN_AS_NODE;
    const r = cp.spawnSync(require(resolve('electron')), [path.join(__dirname, 'board-rail-evidence-electron.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 180000 });
    await new Promise(r => setTimeout(r, 1500));
    for (const name of fs.readdirSync(dir)) if (name.startsWith('profile-')) fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    if (r.error || r.status) throw r.error || Error(`${kind} capture exit ${r.status}`);
  }
  const reports = ['before','after'].filter(k=>fs.existsSync(path.join(out,k,'status.json'))).map(k=>JSON.parse(fs.readFileSync(path.join(out,k,'status.json'))));
  fs.writeFileSync(path.join(out, 'review.html'), `<!doctype html><meta charset="utf-8"><title>Board rail matched evidence</title><style>body{font:14px system-ui;background:#ddd;margin:24px}section{display:grid;grid-template-columns:1fr 1fr;gap:12px}h2{grid-column:1/-1}img,video{width:100%}pre{white-space:pre-wrap}</style><h1>Board rail: ${base} / working-source snapshot</h1><p>Extracted actual App nav JSX; real CommandCenterView and styles; mock host and pane bodies. Offline hidden Electron renderer captures, not native desktop chrome. Human pixel and motion review remains required.</p>${(reports[0]?.captures||[]).map(c=>`<section><h2>${c.name}</h2><div>Before<img src="before/${c.name}.png"></div><div>After<img src="after/${c.name}.png"></div></section>`).join('')}<section><h2>Nav hover CDP motion</h2><video controls src="before/nav-hover.mp4"></video><video controls src="after/nav-hover.mp4"></video></section><pre>${JSON.stringify(reports,null,2)}</pre>`);
})().catch(e => { console.error(e); process.exitCode = 1; });
