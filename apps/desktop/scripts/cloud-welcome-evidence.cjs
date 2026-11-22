// Visual evidence for the Nekko Cloud sign-in walkthrough (#3187): the real
// Settings > Nekko Cloud account section and walkthrough, against a stand-in
// engine in the page (no API, no daemon). Hidden Chromium, nothing on screen.
//
//   node apps/desktop/scripts/cloud-welcome-evidence.cjs     → .shots/cloud-welcome/
//
// CHROMIUM=<path to chrome.exe> picks the browser (Playwright's Chromium, never Edge).
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
// Packages resolve from this checkout, or from the main checkout when run in a worktree.
const nodeModules = [path.join(repo, 'node_modules'), path.resolve(repo, '../../node_modules')].find((p) => fs.existsSync(p));
const need = (m) => require(require.resolve(m, { paths: [nodeModules] }));
const out = path.join(repo, '.shots/cloud-welcome');

async function build() {
  const renderer = path.join(repo, 'apps/desktop/src/renderer').replaceAll('\\', '/');
  const entry = `
import { createRoot } from 'react-dom/client';
import { SyncSettings } from '${renderer}/components/cloud/SyncSettings';
const q = new URLSearchParams(location.search);
document.documentElement.setAttribute('data-theme', q.get('theme') || 'light');
if (q.get('welcomed')) localStorage.setItem('nekko.cloud.welcomed', '1'); else localStorage.removeItem('nekko.cloud.welcomed');
const plan = q.get('plan') || 'free';
const KEY = '7KQ2M-XW9DA-P3RTE-HN6VC-YB8LF-2GZUQ-MJ4SK-T5EWD-AC7NR-QX3HP-L9BVM';
const s = { signedIn: false, account: null, oauthPending: false, keysStoredIn: 'Windows Credential Manager',
  sync: { phase: 'signed-out', enabled: false, recoveryConfirmed: false, keyEpoch: null, lastSyncAt: null, error: null, progress: null,
    chats: 0, pushed: 0, pulled: 0, skipped: {}, fingerprint: null, joinCode: null, devices: [], usage: null } };
const listeners = new Set();
const emit = () => { const c = structuredClone(s); listeners.forEach((cb) => cb(c)); return c; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = (email) => {
  if (email.startsWith('blocked')) throw new Error("Nekko Cloud is invite-only for now. This account isn't on the list yet.");
  s.signedIn = true; s.oauthPending = false;
  s.account = { email, plan, canSync: plan !== 'free', features: { billing: false } };
  s.sync.phase = plan === 'free' ? 'needs-plan' : 'off';
  emit();
};
window.__nekko = { signIn, s, emit };
window.nekko = new Proxy({
  onCloudStatus: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  cloudStatus: async () => structuredClone(s),
  cloudRefresh: async () => structuredClone(s),
  cloudSendCode: async () => { await wait(300); },
  cloudVerifyCode: async (email) => { await wait(300); signIn(email); },
  cloudBeginOAuth: async () => { s.oauthPending = true; emit(); return { authUrl: 'https://github.com/login/oauth/authorize?client_id=demo' }; },
  cloudCancelOAuth: async () => { s.oauthPending = false; emit(); },
  syncTurnOn: async () => { await wait(900); s.sync.phase = 'idle'; s.sync.enabled = true; s.sync.keyEpoch = 1; s.sync.lastSyncAt = Date.now();
    s.sync.devices = [{ id: 'd1', label: 'Studio PC', kind: 'desktop', lastSeenAt: Date.now(), createdAt: null, revoked: false, trusted: true, thisDevice: true }];
    return { recoveryKey: KEY, status: emit() }; },
  syncConfirmRecoveryKey: async (typed) => { if (typed.replace(/[\\s-]/g, '').toUpperCase() !== KEY.replace(/-/g, '')) throw new Error("That isn't the recovery key."); s.sync.recoveryConfirmed = true; emit(); },
  openPath: async () => {},
}, { get(t, k) { return k in t ? t[k] : async () => null; } });
createRoot(document.getElementById('root')).render(
  <div style={{ background: 'var(--paper)', minHeight: '100vh', padding: '24px 32px' }}><div style={{ maxWidth: 760, margin: '0 auto' }}><SyncSettings /></div></div>);
`;
  fs.writeFileSync(path.join(out, 'entry.tsx'), entry);
  await need('esbuild').build({ entryPoints: [path.join(out, 'entry.tsx')], bundle: true, format: 'iife', jsx: 'automatic', outfile: path.join(out, 'fixture.js'),
    nodePaths: [nodeModules], alias: { '@nekko-agent/shared': path.join(repo, 'packages/shared/src/index.ts') },
    loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.css': 'css' } });
  const stylesPath = path.join(repo, 'apps/desktop/src/renderer/styles.css');
  const css = await need('postcss')([need('@tailwindcss/postcss')({ base: repo })]).process(fs.readFileSync(stylesPath, 'utf8'), { from: stylesPath });
  fs.writeFileSync(path.join(out, 'style.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
}

async function main() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  await build();
  const server = require('node:http').createServer((req, res) => {
    const file = path.join(out, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(out) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    fs.createReadStream(file).pipe(res);
  }).listen(4371);
  const browser = await need('playwright').chromium.launch({ headless: true, executablePath: process.env.CHROMIUM || undefined });
  const errors = [];
  try {
    const open = async (query, theme = 'light', size = { width: 1100, height: 860 }, video = false) => {
      const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: video ? 1 : 2, ...(video ? { recordVideo: { dir: path.join(out, 'video'), size } } : {}) });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(String(e)));
      p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await p.goto(`http://127.0.0.1:4371/index.html?theme=${theme}&${query}`);
      await p.waitForSelector('[data-testid=sync-sign-in]');
      return { p, ctx };
    };
    const shot = async (p, name, settle = 900) => { await p.waitForTimeout(settle); await p.screenshot({ path: path.join(out, `${name}.png`) }); };
    const step = (p, s) => p.waitForSelector(`[data-testid=cloud-signin][data-step=${s}]`, { timeout: 15000 });

    for (const theme of ['light', 'dark']) {
      // First sign-in on a Pro account, through the emailed code.
      const { p, ctx } = await open('plan=pro', theme);
      await shot(p, `${theme}-00-settings`, 400);
      await p.click('[data-testid=sync-sign-in]');
      await step(p, 'welcome');
      await shot(p, `${theme}-01-welcome`, 1400);
      await p.click('[data-testid=cw-create]');
      await step(p, 'account');
      await shot(p, `${theme}-02-account`, 1100);
      await p.fill('[data-testid=cloud-email]', 'philip@nekkolabs.com');
      await shot(p, `${theme}-02b-email-typed`, 300);
      await p.click('[data-testid=cloud-send-code]');
      await p.waitForSelector('[data-testid=cloud-otp-0]');
      await p.keyboard.type('4810');
      await shot(p, `${theme}-03-code`, 900);
      await p.keyboard.type('27');
      await step(p, 'in');
      await shot(p, `${theme}-04-in`, 1200);
      await p.click('[data-testid=cw-continue]');
      // A Pro account skips the plan and goes to Sync, which makes the recovery key.
      await step(p, 'sync');
      await shot(p, `${theme}-05-sync-working`, 300);
      await p.waitForSelector('[data-testid=recovery-key]');
      await shot(p, `${theme}-06-recovery-key`, 1200);
      await p.check('[data-testid=recovery-saved]');
      await p.click('[data-testid=recovery-continue]');
      await p.fill('[data-testid=recovery-typed]', '7KQ2M-XW9DA-P3RTE-HN6VC-YB8LF-2GZUQ-MJ4SK-T5EWD-AC7NR-QX3HP-L9BVM');
      await p.click('[data-testid=recovery-confirm]');
      await step(p, 'done');
      await shot(p, `${theme}-07-done`, 1400);
      await p.click('[data-testid=cw-finish]');
      await p.waitForSelector('[data-testid=cloud-signin]', { state: 'detached' });
      await shot(p, `${theme}-08-after`, 500);
      await ctx.close();

      // A free account: the plan, the test checkout, and All set with sync waiting.
      const f = await open('plan=free', theme);
      await f.p.click('[data-testid=sync-create-account]');
      await step(f.p, 'welcome');
      await f.p.click('[data-testid=cw-have-account]');
      await step(f.p, 'account');
      await f.p.click('[data-testid=cloud-github]');
      await f.p.waitForSelector('[data-scene=browser]');
      await shot(f.p, `${theme}-09-browser`, 1200);
      await f.p.evaluate(() => window.__nekko.signIn('sam@nekkolabs.com'));
      await step(f.p, 'in');
      await f.p.click('[data-testid=cw-continue]');
      await step(f.p, 'plan');
      await shot(f.p, `${theme}-10-plan`, 1100);
      await f.p.click('[data-testid=cw-plan-continue]');
      await step(f.p, 'checkout');
      await shot(f.p, `${theme}-11-checkout`, 1600);
      await f.p.click('[data-testid=cw-pay]');
      await shot(f.p, `${theme}-12-paying`, 500);
      await f.p.waitForSelector('[data-testid=cw-checkout][data-state=paid]');
      await shot(f.p, `${theme}-13-paid`, 900);
      await f.p.click('[data-testid=cw-paid-continue]');
      await step(f.p, 'done');
      await shot(f.p, `${theme}-14-done-free`, 1200);
      const doneText = await f.p.textContent('[data-testid=cw-done]');
      if (!doneText.includes('Pro (test mode)') || !doneText.includes('Sync is waiting for Pro')) throw new Error(`free All set says: ${doneText}`);
      await f.ctx.close();

      // Refused: the invite-only answer shows under the choices.
      const r = await open('', theme);
      await r.p.click('[data-testid=sync-sign-in]');
      await r.p.click('[data-testid=cw-have-account]');
      await r.p.fill('[data-testid=cloud-email]', 'blocked@example.com');
      await r.p.click('[data-testid=cloud-send-code]');
      await r.p.waitForSelector('[data-testid=cloud-otp-0]');
      await r.p.keyboard.type('123456');
      await r.p.waitForSelector('[data-testid=cloud-signin] [role=alert]');
      await shot(r.p, `${theme}-15-refused`, 500);
      await r.ctx.close();

      // A later sign-in on this device: straight to Account, no Welcome, at a narrow width.
      const n = await open('welcomed=1', theme, { width: 400, height: 760 });
      await n.p.click('[data-testid=sync-sign-in]');
      await step(n.p, 'account');
      if (await n.p.locator('.cw-dots').count()) throw new Error('a later sign-in showed the step dots');
      await shot(n.p, `${theme}-16-returning-narrow`, 1100);
      await n.ctx.close();
    }

    // A recording of the whole first-run flow for the PR (needs Playwright's ffmpeg: npx playwright install ffmpeg).
    if (process.env.NO_VIDEO) return;
    const v = await open('plan=pro', 'light', { width: 900, height: 760 }, true);
    await v.p.waitForTimeout(600);
    await v.p.click('[data-testid=sync-sign-in]');
    await v.p.waitForTimeout(2600);
    await v.p.click('[data-testid=cw-create]');
    await v.p.waitForTimeout(1500);
    await v.p.click('[data-testid=cloud-github]');
    await v.p.waitForTimeout(2200);
    await v.p.click('[data-testid=cw-oauth-cancel]');
    await v.p.waitForTimeout(800);
    await v.p.type('[data-testid=cloud-email]', 'philip@nekkolabs.com', { delay: 30 });
    await v.p.click('[data-testid=cloud-send-code]');
    await v.p.waitForSelector('[data-testid=cloud-otp-0]');
    await v.p.waitForTimeout(900);
    await v.p.keyboard.type('481027', { delay: 140 });
    await v.p.waitForTimeout(1800);
    await v.p.click('[data-testid=cw-continue]');
    await v.p.waitForSelector('[data-testid=recovery-key]');
    await v.p.waitForTimeout(2200);
    await v.p.click('[data-testid=recovery-saved]');
    await v.p.click('[data-testid=recovery-continue]');
    await v.p.fill('[data-testid=recovery-typed]', '7KQ2M-XW9DA-P3RTE-HN6VC-YB8LF-2GZUQ-MJ4SK-T5EWD-AC7NR-QX3HP-L9BVM');
    await v.p.click('[data-testid=recovery-confirm]');
    await v.p.waitForTimeout(2600);
    const vfile = await v.p.video().path();
    await v.ctx.close();
    fs.renameSync(vfile, path.join(out, 'walkthrough-light.webm'));

    const c = await open('plan=free', 'dark', { width: 900, height: 760 }, true);
    await c.p.click('[data-testid=sync-sign-in]');
    await c.p.click('[data-testid=cw-have-account]');
    await c.p.fill('[data-testid=cloud-email]', 'sam@nekkolabs.com');
    await c.p.click('[data-testid=cloud-send-code]');
    await c.p.waitForSelector('[data-testid=cloud-otp-0]');
    await c.p.keyboard.type('123456');
    await c.p.waitForSelector('[data-testid=cw-continue]');
    await c.p.waitForTimeout(1200);
    await c.p.click('[data-testid=cw-continue]');
    await c.p.waitForTimeout(1500);
    await c.p.click('[data-testid=cw-plan-continue]');
    await c.p.waitForTimeout(2200);
    await c.p.click('[data-testid=cw-pay]');
    await c.p.waitForTimeout(2600);
    await c.p.click('[data-testid=cw-paid-continue]');
    await c.p.waitForTimeout(2000);
    const cfile = await c.p.video().path();
    await c.ctx.close();
    fs.renameSync(cfile, path.join(out, 'checkout-dark.webm'));
  } finally {
    await browser.close();
    server.close();
  }
  if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
  console.log(`evidence in ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
