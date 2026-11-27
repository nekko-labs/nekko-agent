// Hidden, isolated full-App Settings → Storage evidence and interaction checks (#3504).
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
const GB = 1e9, GiB = 2 ** 30;
// This Mac's sizes on 2026-11-26, at the point the disk had 14 GB free.
const fixture = {
  usage: { measuredAt: Date.now() - 120000, measuring: false, disk: { total: 2e12, free: 14 * GB }, worktreeBytes: {}, categories: [
    { id: 'worktrees', bytes: 180 * GB, detail: { count: 158, buildOutputBytes: 135 * GB } },
    { id: 'runners', bytes: 134 * GB },
    { id: 'models', bytes: 53 * GB, detail: { elsewhere: false } },
    { id: 'history', bytes: 1.2 * GB, detail: { picturesBytes: 113e6 } },
    { id: 'caches', bytes: 1.9 * GB },
    { id: 'other', bytes: 70e6 },
  ] },
  images: [
    { name: 'images/default', bytes: 55 * GB, modifiedAt: Date.UTC(2026, 10, 2), inUse: true, kind: 'macos' },
    { name: 'images/linux', bytes: 2.9 * GB, modifiedAt: Date.UTC(2026, 10, 9), inUse: true, kind: 'linux' },
    { name: 'images/linux-cache', bytes: 0.55 * GB, modifiedAt: Date.UTC(2026, 10, 9), inUse: true, kind: 'cache' },
    { name: 'old-image-tart-2026-10-29', bytes: 76 * GB, modifiedAt: Date.UTC(2026, 9, 29), inUse: false, kind: 'other' },
  ],
  preview: { idle: [
    { root: '/Users/me/code/nekko-agent/.worktrees/compact-agents-panel', projectName: 'nekko-agent', branch: 'compact-agents-panel', head: 'a1b2c3d4', bytes: 2.4 * GB, reason: 'pushed' },
    { root: '/Users/me/code/nekko-agent/.worktrees/p4-fleet', projectName: 'nekko-agent', branch: 'feat/p4-fleet', head: 'b2c3d4e5', bytes: 1.9 * GB, reason: 'merged' },
    { root: '/Users/me/code/nekko-agent/.worktrees/3467-compact-cloud-models', projectName: 'nekko-agent', branch: '3467-compact-cloud-models', head: 'c3d4e5f6', bytes: 1.8 * GB, reason: 'merged' },
    { root: '/Users/me/code/nekko-agent/.worktrees/claude-usage-unified-windows', projectName: 'nekko-agent', branch: 'claude-usage-unified-windows', head: 'd4e5f6a7', bytes: 1.6 * GB, reason: 'pushed' },
    { root: '/Users/me/code/nekko-agent/.worktrees/merge-sweep-2518', projectName: 'nekko-agent', branch: null, head: '8c1e0a2ff', bytes: 1.2 * GB, reason: 'pushed' },
  ], kept: { recent: 14, dirty: 9, unpushed: 3, running: 1 } },
  cloud: { signedIn: true, oauthPending: false, keysStoredIn: 'macOS Keychain', account: { email: 'you@example.com', plan: 'pro', canSync: true },
    sync: { phase: 'idle', enabled: true, recoveryConfirmed: true, keyEpoch: 1, lastSyncAt: Date.now(), error: null, progress: null, chats: 212, pushed: 0, pulled: 0, skipped: {}, fingerprint: null, joinCode: null, devices: [],
      usage: { bytes: 2.8 * GiB, limit: 5 * GiB, parts: { chats: 1.6 * GiB, library: 0.9 * GiB, revisions: 0.3 * GiB, shares: 80 * 2 ** 20 } } } },
};
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 1000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') console.error(e.message.slice(0, 500)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, `${name}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const check = async (name, expression) => { const ok = await run(expression); report.checks.push({ name, ok }); if (!ok) throw Error(name); };
  const button = text => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
  const top = sel => `document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'start' })`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    // The low-disk notice reads the disk as the App mounts: seed it, then load again.
    await run(`localStorage.setItem('fixture.disk', ${JSON.stringify(JSON.stringify(fixture.usage.disk))})`);
    await run(`localStorage.setItem('fixture.merged', 'true'); localStorage.removeItem('nekko.storageAudit.snoozedUntil')`);
    await win.reload();
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => {
      const f = layoutFixture, d = ${JSON.stringify(fixture)};
      f.bridge.setSessionOptions = async (id, options) => Object.assign(f.records.find(s => s.id === id), options);
      f.bridge.getRemoteStatus = async () => ({ enabled: false });
      f.bridge.getStorageUsage = async () => d.usage;
      f.bridge.getDiskSpace = async () => d.usage.disk;
      f.bridge.listRunnerImages = async () => d.images;
      f.bridge.previewIdleWorktrees = async () => d.preview;
      f.bridge.removeWorktrees = async roots => { window.removed = roots; return { removed: roots, freed: 7 * 1e9, failed: [] }; };
      f.bridge.removeRunnerImage = async name => { window.removedImage = name; return { freed: 76e9 }; };
      f.bridge.clearAppCaches = async () => { window.cachesCleared = true; };
      f.bridge.cloudStatus = async () => d.cloud;
      f.bridge.getHistoryUsage = async () => ({ bytes: 1.2e9, count: 212 });
      f.store.setState({ view: 'command' });
    })()`);
    await sleep(1200);
    await check('low-disk notice shows', `document.querySelector('[data-low-disk="low"]')?.textContent.includes('Your disk is almost full: 14 GB free.')`);
    await shot('low-disk-notice');
    await check('old merged reminder visible', `!!document.querySelector('[data-merged-reminder]')`);
    await run(`document.querySelector('[data-merged-reminder] button:last-child').click()`);
    await check('not now snoozes for a week without starting a chat', `!document.querySelector('[data-merged-reminder]') && Number(localStorage.getItem('nekko.storageAudit.snoozedUntil')) > Date.now() + 6 * 86400000 && !layoutFixture.lastSend`);
    await run(`${button("See what's using it")}.click()`); await sleep(1200);
    await check('notice opens Storage', `!document.querySelector('#settings-storage').hidden && document.querySelector('[data-storage-row="worktrees"]')?.textContent.includes('180 GB')`);
    await check('rows largest first', `[...document.querySelectorAll('[data-storage-row]')].map(r => r.dataset.storageRow).join() === 'worktrees,runners,models,caches,history,other'`);
    await run(top('#settings-storage')); await sleep(200);
    await shot('storage-desktop');
    await run(`${button('Remove idle worktrees…')}.click()`); await sleep(400);
    await check('preview lists 5 selected', `document.body.textContent.includes('5 of 5 selected')`);
    await run(`${button('Deselect all')}.click()`); await sleep(100);
    await check('deselect all disables remove', `${button('Remove 0 worktrees')}.disabled`);
    await run(`${button('Select all')}.click()`); await sleep(100);
    await run(`document.querySelector('input[data-worktree$="claude-usage-unified-windows"]').click()`); await sleep(100);
    await run(`document.querySelector('[role=alertdialog]').scrollIntoView({ block: 'center' })`); await sleep(150);
    await shot('storage-remove-idle-worktrees');
    await check('nothing removed before confirming', '!window.removed');
    await run(`${button('Remove 4 worktrees')}.click()`); await sleep(400);
    await check('removes only the ticked four', 'window.removed?.length === 4 && !window.removed.some(r => r.endsWith("claude-usage-unified-windows"))');
    await run(`${button('Review images…')}.click()`); await sleep(200);
    await run(`document.querySelector('[data-runner-image="old-image-tart-2026-10-29"] button').click()`); await sleep(200);
    await run(`document.querySelector('[data-runner-image="old-image-tart-2026-10-29"]').scrollIntoView({ block: 'center' })`); await sleep(150);
    await shot('storage-runner-images');
    await check('in-use images have no Remove', `!document.querySelector('[data-runner-image="images/default"] button')`);
    await run(`${button('Remove permanently')}.click()`); await sleep(300);
    await check('removes the leftover image', `window.removedImage === 'old-image-tart-2026-10-29'`);
    await run(`${button('Clear caches…')}.click()`); await sleep(200);
    await run(`document.querySelector('[role=alertdialog]').scrollIntoView({ block: 'center' })`); await sleep(150);
    await shot('storage-clear-caches');
    await run(`${button('Clear caches')}.click()`); await sleep(300);
    await check('clears caches after confirming', 'window.cachesCleared === true');
    await run(top('[data-storage-cloud]')); await sleep(150);
    await check('cloud split by kind', `document.querySelector('[data-storage-cloud]').textContent.includes('Synced chats 1.6 GB')`);
    await shot('storage-cloud');
    await run(`${button('General')}.click()`); await sleep(300);
    await run(top('#chat-history')); await sleep(150);
    await check('General points to Storage', `document.querySelector('#chat-history').textContent.includes('Chat history moved to Storage.')`);
    await shot('general-chat-history-pointer');
    win.setContentSize(390, 844); await sleep(300);
    await run(`${button('Storage')}.click()`); await sleep(300);
    await run(top('#settings-storage')); await sleep(150);
    await check('no horizontal overflow at 390', 'document.documentElement.scrollWidth <= 390');
    await shot('storage-mobile');
    await run(`document.documentElement.dataset.theme = 'light'`); await sleep(300);
    await shot('storage-mobile-light');
    await run(`${button('Run storage audit')}.click()`); await sleep(700);
    await check('Storage starts a folderless audit with no acting tools', `layoutFixture.lastSend?.noTools === true && layoutFixture.lastSend.text.includes('3 protected; 1 unused') && !layoutFixture.lastSend.text.includes('old-image-tart') && layoutFixture.store.getState().view === 'command'`);
    await run(`localStorage.removeItem('nekko.storageAudit.snoozedUntil')`);
    await win.reload();
    for (let i = 0; i < 100 && !(await run(`!!document.querySelector('[data-merged-reminder]') && !!window.layoutFixture`)); i++) await sleep(100);
    await run(`(() => { const f = layoutFixture, d = ${JSON.stringify(fixture)}; f.bridge.getStorageUsage = async () => d.usage; f.bridge.listRunnerImages = async () => d.images; f.bridge.setSessionOptions = async (id, opts) => Object.assign(f.records.find(s => s.id === id), opts); document.querySelector('[data-merged-reminder] button').click(); })()`); await sleep(800);
    await check('reminder starts audit with merge context and does not remove anything', `layoutFixture.lastSend?.noTools === true && layoutFixture.lastSend.text.includes('at least 15 merged') && !window.removed && !window.removedImage && !window.cachesCleared`);
    report.bounds = win.getBounds(); report.visible = win.isVisible();
    if (report.visible) throw Error('fixture became visible');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks.length, failed: report.checks.filter(c => !c.ok).map(c => c.name), errors: report.errors }, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
