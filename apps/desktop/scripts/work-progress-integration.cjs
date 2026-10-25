const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const out = path.join(repo, '.shots/work-progress');
async function main() {
  require('./check-sandbox-syntax.cjs').checkSandboxSyntax(path.join(__dirname, 'work-progress-sandbox.cjs'));
  fs.mkdirSync(out, { recursive: true });
  const revision = process.env.NEKKO_TEST_REVISION;
  let source = repo;
  if (revision) {
    source = path.join(out, 'base-source');
    if (!fs.existsSync(path.join(source, '.complete'))) {
      fs.mkdirSync(source, { recursive: true });
      const archive = path.join(out, 'base.tar');
      cp.execFileSync('git', ['archive', `--output=${archive}`, revision, 'apps/desktop/src', 'packages/shared/src'], { cwd: repo });
      cp.execFileSync('tar', ['-xf', archive, '-C', source]);
      fs.writeFileSync(path.join(source, '.complete'), cp.execFileSync('git', ['rev-parse', revision], { cwd: repo }));
    }
  }
  const kind = revision ? 'before' : 'after';
  const dest = path.join(out, kind); fs.mkdirSync(dest, { recursive: true });
  let fixture = fs.readFileSync(path.join(__dirname, 'work-progress-fixture.tsx'), 'utf8');
  if (revision) fixture = fixture.replace("import { VerificationChecklist } from '../src/renderer/components/WorkProgress';", 'const VerificationChecklist = (_props: any) => null;');
  fixture = fixture.replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer'));
  const entry = path.join(dest, 'fixture.tsx'); fs.writeFileSync(entry, fixture);
  const esbuild = require(path.join(modules, 'esbuild'));
  await esbuild.build({ entryPoints: [entry], bundle: true, jsx: 'automatic', format: 'iife', outfile: path.join(dest, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': path.join(source, 'packages/shared/src/index.ts') }, plugins: [{ name: 'isolated-store', setup(build) { build.onResolve({ filter: /(?:store|prPolling)\.js$/ }, args => ({ path: args.path.includes('prPolling') ? 'poll' : 'store', namespace: 'stub' })); build.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'poll' ? 'export const subscribePrPolling=()=>()=>{};' : 'const state={sessions:[],settings:{},openPrPane:()=>{}}; export const useStore=selector=>selector(state); useStore.getState=()=>state;', loader: 'js' })); } }] });
  const cssPath = path.join(source, 'apps/desktop/src/renderer/styles.css');
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: source })]).process(fs.readFileSync(cssPath, 'utf8'), { from: cssPath });
  fs.writeFileSync(path.join(dest, 'style.css'), css.css + '\nbody{margin:0;background:var(--bg);color:var(--ink);font:14px system-ui}main{max-width:760px;margin:auto;padding:24px 16px}h1{font-size:18px;font-weight:600}.caption{color:var(--ink-faint);margin:8px 0 24px}section{margin:16px 0}');
  fs.writeFileSync(path.join(dest, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
  const env = { ...process.env, NEKKO_COMPONENT_OUT: dest }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, 'work-progress-sandbox.cjs')], { env, cwd: repo, stdio: 'inherit', windowsHide: true, timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
