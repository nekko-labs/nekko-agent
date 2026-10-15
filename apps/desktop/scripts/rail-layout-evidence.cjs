// Production rail styles and source markup, synthetic content, no engine/profile access.
const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const before = process.argv.includes('--before');
const dir = path.join(repo, '.shots/upper-rail', before ? 'before' : 'after');
fs.mkdirSync(dir, { recursive: true });
async function main() {
  const file = p => before ? cp.execFileSync('git', ['show', `HEAD:${p}`], { cwd: repo, encoding: 'utf8' }) : fs.readFileSync(path.join(repo, p), 'utf8');
  const app = file('apps/desktop/src/renderer/App.tsx');
  let nav = app.slice(app.indexOf('<nav className="relative z-40'), app.indexOf('</nav>', app.indexOf('<nav className="relative z-40')) + 6);
  nav = nav.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\{!hasAppChrome && <div[\s\S]*?<\/div>\}/, '');
  const start = nav.indexOf('{visibleNav.map'); const end = nav.indexOf('))}', start) + 3;
  const labels = ['Command Center', 'Agents', 'Skills', 'Training', 'Workflows', 'Design', 'Models', 'Model Server', 'Connectors', 'Memory', 'Settings'];
  nav = nav.slice(0, start) + labels.map((s, i) => `<button class="nav-item${i === 1 ? ' active' : ''}" aria-label="${s}"><span class="grid h-10 w-10 shrink-0 place-items-center"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="3" y="3" width="12" height="12" rx="${i % 3 + 1}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></span><span class="rail-label text-[13px] font-medium">${s}</span></button>`).join('') + nav.slice(end);
  nav = nav.replaceAll('className=', 'class=').replace(/<div([^>]*?)\s*\/>/g, '<div$1></div>');
  const cssPath = path.join(repo, 'apps/desktop/src/renderer/styles.css');
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: repo })]).process(file('apps/desktop/src/renderer/styles.css'), { from: cssPath });
  fs.writeFileSync(path.join(dir, 'style.css'), css.css);
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'"><link rel="stylesheet" href="style.css"></head><body style="margin:0;background:var(--paper);color:var(--ink)"><header style="height:58px;padding:16px 24px;border-bottom:1px solid var(--line)">Nekko Agent · isolated navigation layout</header><div class="relative flex min-h-0 w-full" style="height:calc(100vh - 58px)">${nav}<main style="padding:32px"><h1 style="font-size:24px">Agents</h1><p style="margin-top:12px;color:var(--ink-faint)">Synthetic layout fixture · no sessions or providers</p></main></div></body></html>`);
  const env = { ...process.env, NEKKO_RAIL_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
  const child = cp.spawn(require(path.join(modules, 'electron')), [path.join(__dirname, 'rail-layout-sandbox.cjs')], { env, stdio: 'inherit' }); child.on('exit', code => process.exit(code || 0));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
