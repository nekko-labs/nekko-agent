// Hidden, isolated evidence for the Settings regroup (#3076): Profile first,
// Help out the Nekko Team second, Nekko Cloud third (account only when signed
// out; Sync, Fleet management and the danger zone once signed in), and All
// connections off at the bottom of Connections in danger red.
// NEKKO_LAYOUT_SANDBOX=settings-groups-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
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

const sync = { enabled: false, recoveryConfirmed: true, keyEpoch: null, lastSyncAt: null, error: null, progress: null, chats: 0, pushed: 0, pulled: 0, skipped: {}, fingerprint: null, joinCode: null, devices: [], usage: null };
const signedOut = { signedIn: false, account: null, oauthPending: false, keysStoredIn: 'Windows Credential Manager', sync: { ...sync, phase: 'signed-out' } };
const now = Date.now();
const signedIn = {
  signedIn: true, oauthPending: false, keysStoredIn: 'Windows Credential Manager',
  account: { email: 'you@example.com', plan: 'pro', canSync: true, staff: false, features: { billing: false } },
  sync: {
    ...sync, phase: 'idle', enabled: true, keyEpoch: 1, lastSyncAt: now - 60_000, chats: 128, usage: { bytes: 42 << 20, limit: 5 << 30 },
    devices: [
      { id: 'd1', label: 'Studio PC', fingerprint: 'AB12 CD34 EF56 7890', askedToJoin: false, createdAt: null, revoked: false, trusted: true, thisDevice: true },
      { id: 'd2', label: 'iPhone', fingerprint: '1234 5678 9ABC DEF0', askedToJoin: false, createdAt: null, revoked: false, trusted: true, thisDevice: false },
    ],
  },
};
const org = { id: 'org1', name: 'Nekko Labs', role: 'owner', keyId: 1, memberCount: 2, createdAt: '2026-11-01T00:00:00Z', hasKey: true, sharing: true };
const detail = { ...org, members: [{ userId: 'u1', email: 'you@example.com', role: 'owner', addedAt: '2026-11-01T00:00:00Z', you: true }, { userId: 'u2', email: 'teammate@example.com', role: 'member', addedAt: '2026-11-02T00:00:00Z', you: false }], invites: [] };
const fleet = { orgId: 'org1', orgKeyId: 1, computers: [
  { deviceId: 'd1', name: 'Studio PC', os: 'windows', arch: 'x64', appVersion: '1.0', models: [{ id: 'm1', label: 'Qwen3 8B', runtime: 'llama.cpp' }], online: true, seenAt: now, you: true, verified: true },
  { deviceId: 'd3', name: 'Build Mac', os: 'macos', arch: 'arm64', appVersion: '1.0', models: [], online: false, seenAt: now - 3_600_000, you: false, verified: true, ownerEmail: 'teammate@example.com' },
] };

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') console.error(e.message.slice(0, 500)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  // A hidden window can hand back its last paint: invalidate first so each shot is fresh.
  const shot = async (name) => { win.webContents.invalidate(); await sleep(600); const f = path.join(out, `${name}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  // Recorded, not thrown: the "before" run on main is expected to fail the new layout's checks.
  const check = async (name, expression) => report.checks.push({ name, ok: !!(await run(expression)) });
  const scrollOnce = (selector) => run(`(() => { const t = document.querySelector(${js(selector)}), s = t?.closest('.settings-content'); if (!s || !t) return false; s.scrollTop += t.getBoundingClientRect().top - s.getBoundingClientRect().top - 8; return true; })()`);
  // Twice: the page can still be settling (lists loading) after the first jump.
  const scrollTo = async (selector) => { await scrollOnce(selector); await sleep(600); return scrollOnce(selector); };
  const open = async (status) => {
    await run(`(() => { const f = layoutFixture; const s = ${js(status)};
      f.bridge.cloudStatus = async () => s; f.bridge.cloudRefresh = async () => s; f.bridge.onCloudStatus = () => () => {};
      f.bridge.orgList = async () => ({ orgs: [${js(org)}], invites: [] });
      f.bridge.orgGet = async () => (${js(detail)});
      f.bridge.fleetList = async () => (${js(fleet)});
      f.bridge.connectionsStatus = async () => ({ connections: [] });
      f.store.setState({ view: 'chat' }); })()`);
    await sleep(300);
    await run("layoutFixture.store.setState({ view: 'settings' })");
    await sleep(1500);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);

    await open(signedOut);
    await shot('01-settings-top');
    await check('rail starts Profile, Help out the Nekko Team, Nekko Cloud',
      "JSON.stringify([...document.querySelectorAll('nav[aria-label=\"Settings sections\"] .settings-nav-item')].slice(0, 3).map((b) => b.textContent.trim())) === JSON.stringify(['Profile', 'Help out the Nekko Team', 'Nekko Cloud'])");
    await check('Profile holds name, email, what you do and the About you note',
      "['What Nekko calls you', 'Email for updates', 'What you mostly do', 'More about you'].every((t) => document.getElementById('settings-profile')?.textContent.includes(t))");
    await check('Customize no longer holds About you', "!document.getElementById('settings-customize')?.textContent.includes('More about you')");
    await scrollTo('#settings-cloud, #sync'); // #sync: where the account lived before (main)
    await shot('02-cloud-signed-out');
    await check('signed out: Nekko Cloud shows only the account with Sign in',
      "!!document.querySelector('#settings-cloud [data-testid=sync-sign-in]') && !document.getElementById('sync') && !document.getElementById('organization') && !document.getElementById('cloud-danger')");
    await check('Phone pairing no longer holds Sync', "!document.getElementById('settings-phone')?.querySelector('[data-testid=sync-settings]')");

    await open(signedIn);
    await scrollTo('#settings-cloud, #sync'); // #sync: where the account lived before (main)
    await shot('03-cloud-signed-in');
    await check('signed in: Account, Sync, Fleet management, Danger zone in that order',
      "(() => { const ids = [...document.querySelectorAll('#settings-cloud section[id]')].map((s) => s.id).filter((id) => ['cloud-account', 'sync', 'organization', 'cloud-danger'].includes(id)); return JSON.stringify(ids) === JSON.stringify(['cloud-account', 'sync', 'organization', 'cloud-danger']); })()");
    await check('Fleet management heading', "document.getElementById('organization-heading')?.textContent === 'Fleet management'");
    await scrollTo('#organization');
    await shot('04-fleet-management');

    if (await scrollTo('[data-all-connections-off]')) await run("document.querySelector('[data-all-connections-off]').closest('.settings-content').scrollTop -= 420");
    else await scrollTo('#connections');
    await shot('05-connections-bottom');
    await check('All connections off is the last row of Connections, below Clear connection logs',
      "(() => { const row = document.querySelector('[data-all-connections-off]'); const clear = [...document.querySelectorAll('#settings-connections button')].find((b) => b.textContent === 'Clear connection logs'); return !!row && !!clear && !!(clear.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) && !row.nextElementSibling; })()");
    await check('All connections off reads in danger red', "!!document.querySelector('[data-all-connections-off] .text-danger-text')");

    report.bounds = win.getBounds(); report.visible = win.isVisible();
    if (report.visible) throw Error('fixture became visible');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
