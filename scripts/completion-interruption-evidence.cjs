const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const repo = path.resolve(__dirname, '..'), primary = path.resolve(repo, '../..');
const out = path.join(repo, '.shots/completion-interruption');
const resolve = name => require.resolve(name, { paths: [path.join(primary, 'apps/desktop'), primary, repo] });
const git = args => cp.execFileSync('git', args, { cwd: repo, windowsHide: true, maxBuffer: 40e6 });
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const runtime = path.join(primary, 'apps/desktop/.dev-runtime/44.7.0-win/Nekko Agent.exe');
  if (!fs.existsSync(runtime)) throw Error('Missing read-only Electron runtime: ' + runtime);
  const tracked = git(['ls-tree', '-r', '--name-only', 'd9c2f11a', 'apps/desktop/src/renderer', 'packages/shared/src']).toString().trim().split('\n');
  const manifest = { base: git(['rev-parse', 'd9c2f11a']).toString().trim(), head: git(['rev-parse', 'HEAD']).toString().trim(), runtime, sources: {}, note: 'After is a hashed working-source snapshot. Real MessageBubble/DoneRow and interruption helpers. Notice JSX and notice effect extracted verbatim from ChatPane; surrounding host/session context is synthetic. Not full ChatPane integration or native-window evidence.' };
  for (const kind of ['before', 'after']) {
    const dir = path.join(out, kind), source = path.join(dir, 'source');
    fs.mkdirSync(source, { recursive: true }); manifest.sources[kind] = {};
    for (const p of tracked) {
      const data = kind === 'before' ? git(['show', `d9c2f11a:${p}`]) : fs.readFileSync(path.join(repo, p));
      const dest = path.join(source, p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data);
      manifest.sources[kind][p] = crypto.createHash('sha256').update(data).digest('hex');
    }
    const pane = fs.readFileSync(path.join(source, 'apps/desktop/src/renderer/components/ChatPane.tsx'), 'utf8');
    const effect = pane.slice(pane.indexOf('const [dismissedInterruption, setDismissedInterruption]')).match(/useEffect\(\(\) => \{[\s\S]*?\}, \[session, streaming, held, errorNotice, lastMsgId, dismissedInterruption, question\]\);/);
    if (!effect) throw Error('Could not locate actual notice effect: ' + kind);
    const start = pane.indexOf('{errorNotice && !question && !streaming && (() => {');
    const end = pane.indexOf('})()}', start) + 5;
    if (start < 0 || end < start) throw Error('Could not extract actual notice JSX');
    fs.writeFileSync(path.join(dir, 'extracted-notice.txt'), effect[0] + '\n\n' + pane.slice(start, end));
    let fixture = fs.readFileSync(path.join(__dirname, 'completion-interruption-evidence-fixture.tsx'), 'utf8')
      .replace('// RECONCILE_IMPORT', kind === 'after' ? 'const { reconcileInterruptionNotice } = interruptionHelpers;' : '')
      .replace('// ACTUAL_EFFECT', effect[0]).replace('{/* ACTUAL_NOTICE */}', pane.slice(start, end))
      .replaceAll('../apps/desktop/src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/'));
    const entry = path.join(dir, 'fixture.tsx'); fs.writeFileSync(entry, fixture);
    await require(resolve('esbuild')).build({ entryPoints: [entry], bundle: true, external: ['mermaid'], jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [path.join(primary, 'node_modules'), path.join(primary, 'apps/desktop/node_modules')], alias: { '@nekko-agent/shared': path.join(source, 'packages/shared/src/index.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
    const compiler = require(path.join(primary, 'node_modules/@tailwindcss/node/dist/index.js'));
    const { Scanner } = require(resolve('@tailwindcss/oxide'));
    const scanner = new Scanner({ sources: [{ base: dir.replaceAll('\\', '/'), pattern: '**/*.{ts,tsx}', negated: false }] });
    const css = fs.readFileSync(path.join(dir, 'fixture.css'), 'utf8').replaceAll(/(["'])tailwindcss\1/g, JSON.stringify(path.join(primary, 'node_modules/tailwindcss/index.css').replaceAll('\\', '/')));
    fs.writeFileSync(path.join(dir, 'styled.css'), (await compiler.compile(css, { base: dir, onDependency() {} })).build(scanner.scan()));
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  for (const kind of ['before', 'after']) {
    const dir = path.join(out, kind), env = { ...process.env, NEKKO_EVIDENCE_DIR: dir, NEKKO_EVIDENCE_KIND: kind, NEKKO_EVIDENCE_RUN_ID: runId }; delete env.ELECTRON_RUN_AS_NODE;
    const result = cp.spawnSync(runtime, [path.join(__dirname, 'completion-interruption-evidence-electron.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
    if (result.error && result.pid) cp.spawnSync('taskkill', ['/PID', String(result.pid), '/T', '/F'], { windowsHide: true });
    for (const name of fs.readdirSync(dir).filter(n => n.startsWith('profile-'))) fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
    if (result.error || result.status !== 0) throw result.error || Error(kind + ' failed: ' + result.status);
  }
  const statuses = ['before', 'after'].map(kind => JSON.parse(fs.readFileSync(path.join(out, kind, 'status.json'), 'utf8')));
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const review = path.join(out, `completion-interruption-${runId}-review.html`);
  fs.writeFileSync(review, `<!doctype html><meta charset="utf-8"><title>Delayed completion recording review</title><style>body{font:16px system-ui;margin:24px;background:#eee;color:#222}section{display:grid;grid-template-columns:1fr 1fr;gap:20px}video,img{max-width:100%;background:white}article{min-width:0}</style><h1>Delayed stale to completed transcript</h1><p>Actual extracted ChatPane effect and notice JSX, synthetic transcript and shell. Renderer captures only. Videos are encoded and decoded programmatically, not playback-inspected. Delay: 1500ms. Each recording retains source frames and timestamped DOM observations in its companion JSON.</p>${[1440, 390].flatMap(width => ['light', 'dark'].map(theme => `<h2>${width}px ${theme}</h2><section>${statuses.map(status => { const recording = status.recordings.find(r => r.basename.includes(`-${width}-${theme}-`)); return `<article><h3>${status.kind}</h3><video controls preload="metadata" src="${escape(path.basename(recording.file))}"></video><p><a href="${escape(recording.basename)}.json">Frame and DOM validation log</a></p></article>`; }).join('')}</section>`)).join('')}<h2>Narrow dark static comparison</h2>${['completed', 'delayed-stale', 'delayed-reconciled'].map(state => `<h3>${state}</h3><section>${['before', 'after'].map(kind => `<article><h4>${kind}</h4><img src="${kind}/390-dark-${state}.png" alt="${kind} narrow dark ${state}"></article>`).join('')}</section>`).join('')}`);
  console.log('Review index: ' + review);
  console.log('Evidence saved: ' + out);
})().catch(error => { console.error(error); process.exitCode = 1; });
