const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const repo = path.resolve(__dirname, '..'), primary = path.resolve(repo, '../..');
const out = path.join(repo, '.shots', 'artifact-cards-evidence-' + new Date().toISOString().replace(/[:.]/g, '-'));
const resolve = name => require.resolve(name, { paths: [path.join(primary, 'apps/desktop'), primary, repo] });
const git = args => cp.execFileSync('git', args, { cwd: repo, windowsHide: true, maxBuffer: 30e6 });
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const runtime = process.env.NEKKO_EVIDENCE_RUNTIME || path.join(primary, 'apps/desktop/.dev-runtime/44.7.0-win/Nekko Agent.exe');
  if (!fs.existsSync(runtime)) throw Error('Read-only runtime missing: ' + runtime);
  const tracked = git(['ls-tree', '-r', '--name-only', '24a1bae9', 'apps/desktop/src/renderer', 'packages/shared/src']).toString().trim().split('\n');
  const extra = ['apps/desktop/src/renderer/components/ChatArtifacts.tsx', 'apps/desktop/src/renderer/chatArtifacts.ts'];
  const manifest = { base: git(['rev-parse', '24a1bae9']).toString().trim(), head: git(['rev-parse', 'HEAD']).toString().trim(), runtime, note: 'Head means snapshotted working tree, not a feature commit. New response cards have no before state; baseline shows unchanged Markdown and PlanRail.', sources: {} };
  // Extract baseline before building or running either variant. Never edit production sources.
  for (const kind of ['before', 'after']) {
    const dir = path.join(out, kind), source = path.join(dir, 'source');
    fs.mkdirSync(source, { recursive: true });
    manifest.sources[kind] = {};
    for (const p of [...new Set([...tracked, ...(kind === 'after' ? extra : [])])]) {
      const data = kind === 'before' ? git(['show', `24a1bae9:${p}`]) : fs.readFileSync(path.join(repo, p));
      const dest = path.join(source, p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data);
      manifest.sources[kind][p] = crypto.createHash('sha256').update(data).digest('hex');
    }
    let fixture = fs.readFileSync(path.join(__dirname, 'artifact-cards-evidence-fixture.tsx'), 'utf8');
    if (kind === 'after') fixture = fixture.replace('// EVIDENCE_ARTIFACT_IMPORT', "import { ChatArtifacts } from '../apps/desktop/src/renderer/components/ChatArtifacts';\nimport { chatArtifacts } from '../apps/desktop/src/renderer/chatArtifacts';").replace('{/* EVIDENCE_ARTIFACT_RENDER */}', '<ChatArtifacts artifacts={chatArtifacts(text, basePath)} sessionId={sessionId} />');
    if (kind === 'before') fixture = fixture.replace('Markdown, MarkdownSession', 'Markdown').replace('<MarkdownSession.Provider value={sessionId}>', '').replace('</MarkdownSession.Provider>', '');
    fixture = fixture.replaceAll('../apps/desktop/src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/'));
    const entry = path.join(dir, 'fixture.tsx'); fs.writeFileSync(entry, fixture);
    await require(resolve('esbuild')).build({ entryPoints: [entry], bundle: true, external: ['mermaid'], jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [path.join(primary, 'node_modules'), path.join(primary, 'apps/desktop/node_modules')], alias: { '@nekko-agent/shared': path.join(source, 'packages/shared/src/index.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
    const compiler = require(path.join(primary, 'node_modules/@tailwindcss/node/dist/index.js'));
    const { Scanner } = require(resolve('@tailwindcss/oxide'));
    const scanner = new Scanner({ sources: [{ base: source.replaceAll('\\', '/'), pattern: '**/*.{ts,tsx}', negated: false }] });
    const cssSource = fs.readFileSync(path.join(dir, 'fixture.css'), 'utf8').replaceAll('"tailwindcss"', JSON.stringify(path.join(primary, 'node_modules/tailwindcss/index.css').replaceAll('\\', '/'))).replaceAll("'tailwindcss'", JSON.stringify(path.join(primary, 'node_modules/tailwindcss/index.css').replaceAll('\\', '/')));
    const compiled = await compiler.compile(cssSource, { base: dir, onDependency() {} });
    fs.writeFileSync(path.join(dir, 'styled.css'), compiled.build(scanner.scan()));
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Evidence directory:', out);
  for (const kind of ['before', 'after']) {
    const dir = path.join(out, kind), env = { ...process.env, NEKKO_EVIDENCE_DIR: dir, NEKKO_EVIDENCE_KIND: kind }; delete env.ELECTRON_RUN_AS_NODE;
    const result = cp.spawnSync(runtime, [path.join(__dirname, 'artifact-cards-evidence-electron.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
    // Remove only this fixture's disposable profiles, never runtime/dependency caches.
    for (const name of fs.readdirSync(dir).filter(n => n.startsWith('profile-'))) fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
    if (result.error || result.status !== 0) throw result.error || Error(kind + ' failed: ' + result.status);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
