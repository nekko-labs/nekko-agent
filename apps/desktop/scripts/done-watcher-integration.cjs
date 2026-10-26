// NEKKO_TEST_REVISION=beee7cd1 captures an independent archived before state.
// Omit the revision for after. NEKKO_TEST_LABEL allows immutable evidence names.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const out = path.join(repo, '.shots/done-watcher');
const revision = process.env.NEKKO_TEST_REVISION;
const label = process.env.NEKKO_TEST_LABEL || (revision ? 'before' : 'after');
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw Error('Unsafe evidence label');
async function main() {
  const dir = path.join(out, label);
  if (fs.existsSync(path.join(dir, 'status.json'))) throw Error(`Evidence already exists at ${dir}; use a new NEKKO_TEST_LABEL`);
  fs.mkdirSync(dir, { recursive: true });
  let source = repo;
  if (revision) {
    const sha = cp.execFileSync('git', ['rev-parse', `${revision}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim();
    source = path.join(out, `archive-${sha}`);
    if (!fs.existsSync(path.join(source, 'apps/desktop/src/displayWindows.ts'))) {
      fs.mkdirSync(source, { recursive: true });
      const tar = path.join(out, `${sha}.tar`);
      cp.execFileSync('git', ['archive', '--format=tar', `--output=${tar}`, sha, 'apps/desktop/src', 'packages/shared/src'], { cwd: repo });
      cp.execFileSync('tar', ['-xf', tar, '-C', source]);
      fs.writeFileSync(path.join(source, '.revision'), sha);
    }
  }
  const fixture = fs.readFileSync(path.join(__dirname, 'done-watcher-fixture.tsx'), 'utf8');
  const entry = path.join(dir, 'fixture.tsx');
  fs.writeFileSync(entry, fixture.replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/')));
  const esbuild = require(path.join(modules, 'esbuild'));
  await esbuild.build({ entryPoints: [entry], bundle: true, jsx: 'automatic', format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': path.join(source, 'packages/shared/src/index.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'error' });
  const cssPath = path.join(source, 'apps/desktop/src/renderer/styles.css');
  // Explicitly scan both the real renderer and identical synthetic fixture so
  // utility generation does not depend on the archive's directory layout.
  const cssText = fs.readFileSync(cssPath, 'utf8') + `\n@source "${path.dirname(entry)}";\n@source "${path.dirname(cssPath)}";`;
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: source })]).process(cssText, { from: cssPath });
  fs.writeFileSync(path.join(dir, 'styled.css'), css.css + `
.evidence-shell{min-height:100vh;background:var(--bg);color:var(--ink);font:14px system-ui;padding:24px}.evidence-shell header{margin-bottom:24px}.evidence-shell h1{font-size:22px;font-weight:650}.evidence-shell header p,.evidence-note,footer{font-size:11px;color:var(--ink-faint)}.evidence-columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}.evidence-columns section{min-width:0}.evidence-shell h2{font-size:12px;font-weight:600;margin-bottom:18px}.evidence-shell article{margin-bottom:20px}.evidence-note{margin-bottom:6px}.evidence-frame{height:74px}.evidence-pane-content{padding:8px;font-size:11px;color:var(--ink-faint)}.evidence-composer{width:100%;max-width:100%;overflow:hidden}.evidence-input{font-size:12px;color:var(--ink-faint);padding:14px 10px}.evidence-shell footer{margin-top:24px}@media(max-width:600px){.evidence-shell{padding:18px}.evidence-columns{grid-template-columns:minmax(0,1fr)}.evidence-shell header{margin-bottom:18px}.evidence-shell article{margin-bottom:16px}}
`);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ source, revision: revision || 'working-tree', head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), fixtureSha256: crypto.createHash('sha256').update(fixture).digest('hex'), statusSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(source, 'apps/desktop/src/renderer/components/WorkspaceCard.tsx'))).digest('hex'), theme: 'light (default)', scope: 'Focused real components; composer equivalent; not production caller integration' }, null, 2));
  const env = { ...process.env, NEKKO_DONE_WATCHER_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, 'done-watcher-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 90000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
