// Hidden, isolated evidence for paged Settings: a rail with two labels (Nekko
// Agent, Privacy and devices), one group on screen at a time, Appearance (was
// Customize) without the system prompt, Phone and computers as one page, and a
// search that reaches every page and lands on the match's page when closed.
// NEKKO_LAYOUT_SANDBOX=settings-paged-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
// (NEKKO_TEST_SOURCE=<main checkout> for "before"). Stub bridge only: no host, cloud or web.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const unsafe = new RegExp('[<>/' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const js = (v) => JSON.stringify(v).replace(unsafe, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };

const now = Date.now();
const signedIn = {
  signedIn: true, oauthPending: false, keysStoredIn: 'Windows Credential Manager',
  account: { email: 'you@example.com', plan: 'pro', canSync: true, staff: false, features: { billing: false } },
  sync: {
    phase: 'idle', enabled: true, recoveryConfirmed: true, keyEpoch: 1, lastSyncAt: now - 60_000, error: null, progress: null, chats: 128, pushed: 0, pulled: 0, skipped: {}, fingerprint: null, joinCode: null,
    usage: { bytes: 42 << 20, limit: 5 << 30 },
    devices: [{ id: 'd1', label: 'Studio PC', fingerprint: 'AB12 CD34 EF56 7890', askedToJoin: false, createdAt: null, revoked: false, trusted: true, thisDevice: true }],
  },
};

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') console.error(e.message.slice(0, 500)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  // A hidden window can hand back its last paint: invalidate first so each shot is fresh.
  // After a reload the first capture can still be a frame behind, so take one to throw away.
  const shot = async (name) => { win.webContents.invalidate(); await sleep(600); await win.capturePage(undefined, { stayHidden: true }); win.webContents.invalidate(); await sleep(400); const f = path.join(out, `${name}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  // Recorded, not thrown: the "before" run on main is expected to fail the new layout's checks.
  const check = async (name, expression) => report.checks.push({ name, ok: !!(await run(expression)) });
  // The groups a person can see right now (a hidden group has no box).
  const visible = "[...document.querySelectorAll('[data-settings-group]')].filter((g) => g.getClientRects().length).map((g) => g.dataset.settingsGroup)";
  const click = (label) => run(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Settings sections"] .settings-nav-item')].find((x) => x.textContent.trim() === ${js(label)}); b?.click(); return !!b; })()`);
  const openSettings = async () => {
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => { const f = layoutFixture; const s = ${js(signedIn)};
      f.bridge.cloudStatus = async () => s; f.bridge.cloudRefresh = async () => s; f.bridge.onCloudStatus = () => () => {};
      f.bridge.orgList = async () => ({ orgs: [], invites: [] });
      f.bridge.connectionsStatus = async () => ({ connections: [] });
      f.store.setState({ view: 'chat' }); })()`);
    await sleep(300);
    await run("layoutFixture.store.setState({ view: 'settings' })");
    await sleep(1500);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    // Simple mode with no computers: the page is only Phone pairing.
    await run("localStorage.setItem('nekko.chatMode', 'simple')");
    win.reload();
    await sleep(1500);
    await openSettings();
    await check('Simple, no computers: the rail says Phone pairing', "[...document.querySelectorAll('.settings-nav-item')].some((b) => b.textContent.trim() === 'Phone pairing') && !document.getElementById('settings-computers')");
    // Detailed: Phone and computers.
    await run("localStorage.setItem('nekko.chatMode', 'expert')");
    win.reload();
    await sleep(1500);
    await openSettings();

    await shot('01-profile-page');
    await check('rail labels: Nekko Agent, then Privacy and devices',
      "JSON.stringify([...document.querySelectorAll('.settings-nav-label')].map((l) => l.textContent)) === JSON.stringify(['Nekko Agent', 'Privacy and devices'])");
    await check('rail order under the labels', "JSON.stringify([...document.querySelectorAll('nav[aria-label=\"Settings sections\"] .settings-nav-item')].map((b) => b.textContent.trim())) === JSON.stringify(['Profile', 'Help out the Nekko Team', 'Nekko Cloud', 'General', 'Appearance', 'Agents', 'Tools', 'Safety', 'Connections', 'Phone and computers', 'System'])");
    await check('opens on Profile alone', `JSON.stringify(${visible}) === '["profile"]'`);

    await click('Nekko Cloud');
    await sleep(800);
    await shot('02-cloud-page');
    await check('Nekko Cloud shows alone, from its top', `JSON.stringify(${visible}) === '["cloud"]' && document.querySelector('.settings-content').scrollTop === 0`);
    await check('the rail marks Nekko Cloud as the page on screen', "document.querySelector('nav[aria-label=\"Settings sections\"] [aria-current=page]')?.textContent.trim() === 'Nekko Cloud'");

    await click('Appearance');
    await sleep(800);
    await shot('03-appearance-page');
    await check('Appearance has no system prompt', `JSON.stringify(${visible}) === '["customize"]' && !document.getElementById('settings-customize').innerText.includes('System prompt')`);

    await click('Agents');
    await sleep(800);
    await check('Agents holds the system prompt', "document.getElementById('settings-agents').innerText.includes('System prompt')");

    await click('Phone and computers');
    await sleep(800);
    await shot('04-phone-and-computers');
    await check('Phone and computers is one page holding both', `JSON.stringify(${visible}) === '["phone"]' && !!document.querySelector('#settings-phone #settings-computers')`);

    // Search from Phone and computers for something on Nekko Cloud.
    await run("document.querySelector('button[aria-label=\"Search settings\"]').click()");
    await sleep(300);
    await run(`(() => { const i = document.querySelector('.settings-search-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Delete account'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await sleep(1200);
    await shot('05-searching');
    await check('searching shows every page', `${visible}.length >= 10`);
    await run("document.querySelector('.settings-search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await sleep(1000);
    await shot('06-after-search');
    await check('closing the search lands on the match page', `JSON.stringify(${visible}) === '["cloud"]'`);

    report.bounds = win.getBounds(); report.visible = win.isVisible();
    if (report.visible) throw Error('fixture became visible');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
