// Synthetic Settings > Remote access evidence for #3346: Phones connect through
// Tailscale and/or Nekko Cloud Relay, and per-device ticks. Never connects to
// the user's host, profile, relay or the web.
// Run: NEKKO_SANDBOX=connect-through-sandbox.cjs node apps/desktop/scripts/tailnet-default-integration.cjs
// (NEKKO_TEST_REVISION=<rev> for "before"). Hidden, non-focusable, off-screen window; clicks are DOM events.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through tailnet-default-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const blocked = [];
  session.defaultSession.webRequest.onBeforeRequest((request, done) => {
    const allow = /^(file:|data:|blob:|devtools:)/.test(request.url);
    if (!allow) blocked.push(request.url);
    done({ cancel: !allow });
  });
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const report = { checks: [], errors: [], measures: {} };
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  const win = new BrowserWindow({
    width: 900, height: 1400, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic remote access verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error' && !/ERR_BLOCKED|net::/.test(e.message)) report.errors.push('console: ' + e.message); });
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const capture = async (name) => {
    await sleep(400);
    const h = await run(`Math.ceil(document.querySelector('section').getBoundingClientRect().bottom + 20)`);
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage({ x: 0, y: 0, width: 900, height: Math.min(h, 1400) }, { stayHidden: true, stayAwake: false })).toPNG());
  };
  const show = async (name) => { await run(`window.confirm = () => true; integration.show('${name}')`); await sleep(1200); };
  const calls = () => run('[...integration.calls]');
  const click = (sel) => run(`document.querySelector(${JSON.stringify(sel)}).click()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await run(`document.documentElement.dataset.theme='dark'`);
    for (const name of ['pro-off', 'pro-both', 'pro-cloud-only']) {
      await show(name);
      await capture(name);
    }
    if (!base) {
      await show('pro-off');
      const text = await run(`document.querySelector('section').textContent`);
      check('offers both ways as ticks, without the relay host', text.includes('Phones connect through') && !text.includes('fly.dev'));
      check('Tailscale and Nekko Cloud Relay are both ticked by default on Pro', await run(`[...document.querySelectorAll('[data-shot="connect-through"] [role=checkbox]')].map((b) => b.getAttribute('aria-checked')).join() === 'true,true'`));
      await click('[data-shot="connect-through"] [aria-label="Tailscale"]');
      await sleep(300);
      await run(`[...document.querySelectorAll('section button')].find((b) => b.textContent.trim() === 'Turn on remote access').click()`);
      await sleep(1200);
      check('Nekko Cloud Relay alone turns remote access on through it', JSON.stringify(await calls()) === JSON.stringify(['remote:enable wss://nekko-agent-relay.fly.dev']));
      await capture('pro-cloud-turned-on');

      await show('pro-both');
      await click('[data-shot="connect-through"] [aria-label="Tailscale"]');
      await sleep(1200);
      check('unticking Tailscale moves the room to Nekko Cloud Relay alone', JSON.stringify(await calls()) === JSON.stringify(['remote:enable wss://nekko-agent-relay.fly.dev', 'remote:setRelays ']));
      check('the last tick stays on', await run(`document.querySelector('[data-shot="connect-through"] [aria-label="Nekko Cloud Relay"]').disabled`));
      await capture('pro-untick-tailscale');

      await show('pro-cloud-only');
      await click('[data-shot="connect-through"] [aria-label="Tailscale"]');
      await sleep(1200);
      check('ticking Tailscale makes it the main relay and keeps Nekko Cloud Relay', JSON.stringify(await calls()) === JSON.stringify(['remote:enable ws://gomi.tailfd6474.ts.net:4400', 'remote:setRelays wss://nekko-agent-relay.fly.dev']));

      await show('pro-both');
      await run(`[...document.querySelectorAll('[aria-label="How iPad connects"] [role=checkbox]')].find((b) => b.textContent.includes('Nekko Cloud Relay')).click()`);
      await sleep(900);
      check('a device untick sets its route', JSON.stringify(await calls()) === JSON.stringify(['remote:setRoute d2 direct']));
      check('no horizontal overflow', !(await run('document.documentElement.scrollWidth > innerWidth')));
    }
    check('the renderer requested nothing from the web', blocked.length === 0);
    report.success = !report.errors.length && (base || report.checks.every((c) => c.passed));
  } catch (error) {
    report.errors.push(String((error && error.stack) || error)); report.success = false;
  } finally {
    report.blocked = blocked;
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, failed: report.checks.filter((c) => !c.passed).map((c) => c.name), passed: report.checks.filter((c) => c.passed).length, total: report.checks.length, errors: report.errors.slice(0, 6) }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
