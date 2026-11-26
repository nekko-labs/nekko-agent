// Isolated component evidence for synced chat pictures (#3298). No bridge, real data, network or visible window.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 900, height: 420, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [] };
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1200);
    for (const width of [900, 390]) {
      win.setContentSize(width, width < 500 ? 520 : 420); await sleep(400);
      await win.capturePage(undefined, { stayHidden: true }); await sleep(200);
      const file = path.join(out, `synced-pictures-${width}.png`);
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      report.captures.push(file);
    }
    report.broken = await run("[...document.images].filter(i => i.complete && i.naturalWidth === 0).length");
    report.placeholders = await run("document.querySelectorAll('[data-picture-missing]').length");
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(report.errors.length ? 1 : 0);
});
