// Isolated component evidence for the approval bar. No bridge, real data,
// network or visible window.
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
  const win = new BrowserWindow({ width: 1100, height: 320, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [] };
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1000);
    for (const width of [1100, 640]) {
      win.setContentSize(width, 320); await sleep(300);
      report['buttons-' + width] = await run("({ mcp: [...document.querySelectorAll('[data-approval=mcp] button')].map(b => b.textContent), bash: [...document.querySelectorAll('[data-approval=bash] button')].map(b => b.textContent) })");
      await win.capturePage(undefined, { stayHidden: true }); await sleep(200);
      const file = path.join(out, `approval-bar-${width}.png`);
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      report.captures.push(file);
    }
    if (win.isVisible() || win.isFocused()) report.errors.push('Window was visible or focused');
    report.success = report.errors.length === 0;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
