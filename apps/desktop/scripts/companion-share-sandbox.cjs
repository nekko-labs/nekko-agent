// A document opened beside an agent on the wall: how much of the window the
// companion column takes by default. Hidden, off-screen, non-focusable,
// isolated profile; launch through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_SANDBOX=companion-share-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'companion-profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run("!!window.layoutFixture && !!document.querySelector('[data-command-wall]')")); i++) await sleep(200);
    await sleep(900);
    await run(`(() => {
      const f = layoutFixture;
      const doc = ['# Oldest-20 work ledger', '', 'Snapshot of the twenty oldest open issues, sorted by creation time.', '', '## Requested blockers', '', '| Work | Result | Remaining |', '| --- | --- | --- |', '| #548 relay | DNS rechecked | Owner to confirm the app |', '| #1096 keychain | Fixed and merged | Signing is a separate gate |'].join('\\n');
      f.bridge.readFile = async () => ({ content: doc, binary: false, truncated: false });
      f.bridge.listComments = async () => [];
      const s = f.store.getState();
      f.store.getState().openFilePane('C:/fixture/code/work-ledger.md', s.activeSessionId);
    })()`);
    for (let i = 0; i < 30 && !(await run("!!document.querySelector('[data-companions-visible] .command-wall-companions')")); i++) await sleep(200);
    await sleep(900);
    report.metrics = JSON.parse(await run(`JSON.stringify((() => {
      const content = document.querySelector('[data-companions-visible]');
      const w = s => Math.round(content?.querySelector(s)?.getBoundingClientRect().width ?? 0);
      const total = Math.round(content?.getBoundingClientRect().width ?? 0);
      const companions = w(':scope > .command-wall-companions');
      return { window: total, chat: w(':scope > .command-wall-primary'), companions, share: total ? Math.round(companions / total * 100) : null };
    })())`));
    await shot('companion-share');
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length && !report.errors.length ? 0 : 1);
});
