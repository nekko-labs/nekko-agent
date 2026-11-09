// Captures quiet-screens-fixture.tsx dark and light, plus a hovered row. Hidden, off-screen, non-focusable.
// NEKKO_LAYOUT_FIXTURE=quiet-screens-fixture.tsx NEKKO_LAYOUT_SANDBOX=quiet-screens-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1640, height: 640, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(2500);
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.setAttribute('data-theme', '${theme}')`);
      await sleep(600);
      await shot(`screens-${theme}`);
    }
    await run(`document.documentElement.setAttribute('data-theme', 'dark')`);
    const r = JSON.parse(await run(`JSON.stringify((() => { const e = document.querySelector('[data-method="k1"]') || document.querySelector('li'); const b = e.getBoundingClientRect(); return { x: b.left + 40, y: b.top + 10 }; })())`));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(r.x), y: Math.round(r.y) });
    await sleep(400);
    await shot('screens-dark-hover');
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.errors));
  app.exit(report.captures.length ? 0 : 1);
});
