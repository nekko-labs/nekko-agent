// Visual evidence for Settings → Sync and the Nekko Cloud sign-in screen,
// against the real engine and API: the local dev API (apps/nekko-agent-api,
// PGlite + fake Supabase Auth) and three `nekko-cloud` bridges, one per
// "computer". The renderer's window.nekko calls go to a bridge over HTTP;
// everything else is the real component. Hidden Chromium, nothing on screen.
//
//   cargo build -p nekko-cloud --example bridge
//   npm run build -w nekko-agent-api   (or: cd apps/nekko-agent-api && npx tsc -p .)
//   node apps/desktop/scripts/sync-evidence.cjs        → .shots/sync/
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');
const repo = path.resolve(__dirname, '../../..');
const out = path.join(repo, '.shots/sync');
const bridgeBin = path.join(repo, 'target/debug/examples/bridge');
const procs = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function start(cmd, args, env = {}, cwd = repo) {
  const p = cp.spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  procs.push(p);
  return p;
}
async function up(url) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await wait(150); }
  throw new Error(`not up: ${url}`);
}
async function call(bridge, channel, args = []) {
  const r = await (await fetch(`${bridge}/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel, args }) })).json();
  if (r.error) throw new Error(`${channel}: ${r.error}`);
  return r.ok;
}

async function build() {
  const renderer = path.join(repo, 'apps/desktop/src/renderer').replaceAll('\\', '/');
  const entry = `
import { createRoot } from 'react-dom/client';
import { SyncSettings } from '${renderer}/components/cloud/SyncSettings';
import { SyncVisual } from '${renderer}/components/cloud/SyncVisual';
const q = new URLSearchParams(location.search);
const bridge = q.get('bridge');
document.documentElement.setAttribute('data-theme', q.get('theme') || 'light');
const channel = (m) => m.replace(/^cloud|^sync/, (p) => p + ':').replace(/:(\\w)/, (_, c) => ':' + c.toLowerCase());
const listeners = new Set();
let last = '';
setInterval(async () => { try { const s = await (await fetch(bridge + '/status')).json(); const t = JSON.stringify(s); if (t !== last) { last = t; listeners.forEach((cb) => cb(s)); } } catch {} }, 250);
window.nekko = new Proxy({
  onCloudStatus: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  openPath: async (url) => { await fetch(url, { mode: 'no-cors' }).catch(() => {}); },
}, { get(t, k) {
  if (k in t) return t[k];
  if (/^(cloud|sync)[A-Z]/.test(k)) return async (...args) => {
    const r = await (await fetch(bridge + '/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: channel(k), args }) })).json();
    if (r.error) throw new Error(r.error);
    return r.ok;
  };
  return async () => null;
} });
const root = createRoot(document.getElementById('root'));
if (q.get('visual')) {
  root.render(<div style={{ padding: 40, background: 'var(--paper)', minHeight: '100vh' }}><div className="card sync-card mx-auto p-5" style={{ maxWidth: 560 }}><div className="sync-card-hero"><SyncVisual phase={q.get('visual')} others={2} /></div></div></div>);
} else {
  root.render(<div style={{ background: 'var(--paper)', minHeight: '100vh', padding: '24px 32px' }}><div style={{ maxWidth: 760, margin: '0 auto' }}><SyncSettings /></div></div>);
}`;
  fs.writeFileSync(path.join(out, 'entry.tsx'), entry);
  await require('esbuild').build({ entryPoints: [path.join(out, 'entry.tsx')], bundle: true, format: 'iife', jsx: 'automatic', outfile: path.join(out, 'fixture.js'),
    nodePaths: [path.join(repo, 'node_modules')], alias: { '@nekko-agent/shared': path.join(repo, 'packages/shared/src/index.ts') },
    loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.css': 'css' } });
  const css = await require('postcss')([require('@tailwindcss/postcss')({ base: repo })]).process(fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/styles.css'), 'utf8'), { from: path.join(repo, 'apps/desktop/src/renderer/styles.css') });
  fs.writeFileSync(path.join(out, 'style.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
}

async function main() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  await build();
  const api = path.join(repo, 'apps/nekko-agent-api');
  start('node', ['dist/dev/local.js'], { PORT: '4350', DEV_CODE: '123456' }, api);
  start('node', ['dist/dev/local.js'], { PORT: '4360', DEV_CODE: '123456', DEV_PLAN: 'free' }, api);
  await up('http://127.0.0.1:4350/healthz'); await up('http://127.0.0.1:4360/healthz');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-evidence-'));
  const A = 'http://127.0.0.1:4351', B = 'http://127.0.0.1:4352', F = 'http://127.0.0.1:4353';
  start(bridgeBin, [path.join(tmp, 'a'), 'http://127.0.0.1:4350', '4351', 'Studio Mac', '14']);
  start(bridgeBin, [path.join(tmp, 'b'), 'http://127.0.0.1:4350', '4352', 'MacBook Air', '3']);
  start(bridgeBin, [path.join(tmp, 'f'), 'http://127.0.0.1:4360', '4353', 'Home PC', '2']);
  for (const u of [A, B, F]) await up(`${u}/status`);

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const server = require('node:http').createServer((req, res) => {
    const file = path.join(out, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(out) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    fs.createReadStream(file).pipe(res);
  }).listen(4359);
  const page = async (bridge, extra = '') => {
    const p = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
    await p.goto(`http://127.0.0.1:4359/index.html?bridge=${encodeURIComponent(bridge)}${extra}`);
    await p.waitForSelector('[data-testid=sync-settings]');
    await p.waitForTimeout(600);
    return p;
  };
  const both = async (p, name, target = '[data-testid=sync-settings]', settle = 350) => {
    for (const theme of ['light', 'dark']) {
      await p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await p.waitForTimeout(settle);
      const el = target === 'page' ? p : p.locator(target);
      await el.screenshot({ path: path.join(out, `${name}-${theme}.png`) });
    }
  };
  const phase = (p, text) => p.waitForFunction((t) => document.querySelector('[data-testid=sync-phase]')?.textContent?.includes(t), text, { timeout: 20000 });

  const email = 'ada@nekko.dev';
  // A: signed out → sign-in screen → code → off.
  const a = await page(A);
  await both(a, '01-signed-out');
  await a.click('[data-testid=sync-sign-in]');
  await a.waitForSelector('[data-testid=cloud-signin]');
  await both(a, '02-sign-in', 'page');
  await a.fill('[data-testid=cloud-email]', email);
  await a.click('[data-testid=cloud-send-code]');
  await a.waitForSelector('[data-testid=cloud-otp-0]');
  await both(a, '03-code', 'page');
  await a.fill('[data-testid=cloud-otp-0]', '123456');
  await phase(a, 'Off');
  await both(a, '04-off');
  // Turn on: the recovery key, the kit, typing it back.
  await a.click('[data-testid=sync-turn-on]');
  await a.waitForSelector('[data-testid=recovery-key]');
  const recovery = (await a.locator('[data-testid=recovery-key] span').allTextContents()).join('-');
  await both(a, '05-recovery-key', 'page');
  await a.check('[data-testid=recovery-saved]');
  await a.click('[data-testid=recovery-continue]');
  await a.fill('[data-testid=recovery-typed]', recovery.toLowerCase());
  await both(a, '06-recovery-confirm', 'page');
  await a.click('[data-testid=recovery-confirm]');
  await a.waitForSelector('[data-testid=recovery-dialog]', { state: 'detached' });
  await phase(a, 'Up to date');
  await both(a, '07-up-to-date');

  // B: same account, so it has to join; it asks, and shows its code.
  await call(B, 'cloud:sendCode', [email]);
  await call(B, 'cloud:verifyCode', [email, '123456']);
  const b = await page(B);
  await phase(b, 'Add this computer');
  await both(b, '08-needs-join');
  await b.click('[data-testid=sync-request-join]');
  await phase(b, 'Waiting for approval');
  await both(b, '09-awaiting-approval');
  const joinCode = (await b.locator('[data-testid=sync-join-code]').textContent()).trim();
  // A sees B waiting and approves it by typing the code B shows.
  await call(A, 'cloud:refresh');
  await a.waitForSelector('[data-testid=sync-approve]', { timeout: 20000 });
  await a.click('[data-testid=sync-approve]');
  await a.fill('[data-testid=sync-approve-code]', joinCode);
  await both(a, '10-approve');
  await a.click('[data-testid=sync-approve-form] button[type=submit]');
  await a.waitForSelector('[data-testid=sync-approve-form]', { state: 'detached', timeout: 20000 });
  await call(B, 'sync:now');
  await phase(b, 'Up to date');
  await call(A, 'sync:now');
  await a.reload(); await a.waitForTimeout(800);
  await both(a, '11-two-devices');

  // A free account: sync isn't included.
  await call(F, 'cloud:sendCode', ['sam@nekko.dev']);
  await call(F, 'cloud:verifyCode', ['sam@nekko.dev', '123456']);
  const f = await page(F);
  await phase(f, 'Not included');
  await both(f, '12-needs-plan');

  // The animation, recorded: the picture with the syncing phase held for the clip.
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 640, height: 300 }, recordVideo: { dir: path.join(out, 'video'), size: { width: 640, height: 300 } } });
    const v = await ctx.newPage();
    await v.goto(`http://127.0.0.1:4359/index.html?bridge=${encodeURIComponent(A)}&visual=syncing&theme=${theme}`);
    await v.waitForTimeout(4200);
    const file = await v.video().path();
    await ctx.close();
    fs.renameSync(file, path.join(out, `13-syncing-animation-${theme}.webm`));
  }
  const still = await browser.newPage({ viewport: { width: 640, height: 300 }, deviceScaleFactor: 2 });
  for (const ph of ['syncing', 'idle', 'error', 'awaiting-approval', 'off']) {
    await still.goto(`http://127.0.0.1:4359/index.html?bridge=${encodeURIComponent(A)}&visual=${ph}&theme=light`);
    await still.waitForTimeout(900);
    await still.locator('.sync-card').screenshot({ path: path.join(out, `14-visual-${ph}.png`) });
  }
  await browser.close();
  server.close();
  console.log(`wrote ${fs.readdirSync(out).filter((f) => /\.(png|webm)$/.test(f)).length} files to ${out}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { for (const p of procs) p.kill(); });
