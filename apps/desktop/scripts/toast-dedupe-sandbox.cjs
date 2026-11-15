// Hidden capture of toast-dedupe-fixture.tsx in a disposable profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_window, _permission, done) => done(false));
  const report = { errors: [], checks: {}, captures: [] };
  const win = new BrowserWindow({ width: 420, height: 320, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    win.on('focus', () => report.errors.push('Window took focus'));
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    await win.loadFile(path.join(out, 'index.html'));
    const run = code => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 80 && !await run('!!window.toastFixtureReady'); i++) await sleep(100);
    await sleep(800);
    report.checks.toasts = await run('document.querySelectorAll("[data-toast]").length');
    report.checks.hidden = !win.isVisible() && !win.isFocused();
    fs.writeFileSync(path.join(out, 'toasts.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push('toasts.png');
  } catch (error) { report.errors.push(String(error.stack || error)); } finally { win.destroy(); }
  console.log(JSON.stringify(report));
  app.exit(report.errors.length ? 1 : 0);
});
