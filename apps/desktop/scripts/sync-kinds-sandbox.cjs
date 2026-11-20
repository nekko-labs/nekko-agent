// Hidden, isolated evidence for the per-kind sync switches (#3089): Settings >
// Nekko Cloud > Sync lists What syncs, Chats and Library (Library only with
// Library sync), each with its own switch, greyed while Sync this computer is off.
// NEKKO_LAYOUT_SANDBOX=sync-kinds-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
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
  // A hidden window can hand back its last paint: a one-pixel resize and invalidate() make each shot fresh.
  const shot = async (name) => { win.setContentSize(1280, 901); await sleep(150); win.setContentSize(1280, 900); win.webContents.invalidate(); await sleep(600); const f = path.join(out, `${name}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
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
  const withSync = (over, libraryCloud = true) => ({ ...signedIn,
    account: { ...signedIn.account, features: { billing: false, libraryCloud } },
    sync: { ...signedIn.sync, kinds: { chats: true, library: true }, ...over } });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);

    await open(withSync({}));
    // [data-testid=sync-now]: the Sync row, also there before (main).
    await scrollTo('[data-testid=sync-kinds], [data-testid=sync-now]');
    await shot('01-what-syncs');
    await check('What syncs lists Chats and Library, both on',
      "(() => { const rows = [...document.querySelectorAll('[data-sync-kind]')].map((r) => r.dataset.syncKind); return JSON.stringify(rows) === JSON.stringify(['chats', 'library']) && [...document.querySelectorAll('[data-sync-kind] [role=switch]')].every((t) => t.getAttribute('aria-checked') === 'true'); })()");
    await check('What syncs sits between the Sync row and Devices',
      "(() => { const k = document.querySelector('[data-testid=sync-kinds]'), now = document.querySelector('[data-testid=sync-now]'), dev = document.querySelector('[data-testid=sync-devices]'); return !!k && !!now && !!dev && !!(now.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(k.compareDocumentPosition(dev) & Node.DOCUMENT_POSITION_FOLLOWING); })()");

    await open(withSync({ kinds: { chats: false, library: true } }));
    await scrollTo('[data-testid=sync-kinds], [data-testid=sync-now]');
    await shot('02-chats-off');
    await check('Chats off says chats stay on this computer',
      "(() => { const r = document.querySelector('[data-sync-kind=chats]'); return !!r && r.textContent.includes('Chats stay on this computer') && r.querySelector('[role=switch]').getAttribute('aria-checked') === 'false'; })()");

    await open(withSync({ enabled: false, phase: 'paused' }));
    await scrollTo('[data-testid=sync-kinds], [data-testid=sync-now]');
    await shot('03-sync-paused');
    await check('Paused: both switches greyed with the reason',
      "(() => { const rows = [...document.querySelectorAll('[data-sync-kind]')]; return rows.length === 2 && rows.every((r) => r.textContent.includes('Paused while Sync this computer is off') && r.querySelector('[role=switch]').disabled); })()");

    await open(withSync({}, false));
    await scrollTo('[data-testid=sync-kinds], [data-testid=sync-now]');
    await shot('04-no-library-sync');
    await check('Without Library sync only Chats is listed',
      "JSON.stringify([...document.querySelectorAll('[data-sync-kind]')].map((r) => r.dataset.syncKind)) === JSON.stringify(['chats'])");

    report.bounds = win.getBounds(); report.visible = win.isVisible();
    if (report.visible) throw Error('fixture became visible');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
