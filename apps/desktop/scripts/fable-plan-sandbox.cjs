// Captures the Claude Agent picker on a Pro and a Max plan, hidden and off-screen.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 720, height: 640, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: {}, errors: [], captures: [] };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  try {
    for (const plan of ['pro', 'max']) {
      await win.loadFile(path.join(out, 'index.html'), { query: { plan } });
      for (let i = 0; i < 80 && !await run('document.querySelectorAll("[data-model-row]").length >= 5'); i++) await sleep(100);
      await sleep(600);
      report.checks[plan] = await run(`Array.from(document.querySelectorAll('[data-model-row]')).map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      const file = path.join(out, `picker-${plan}-${process.env.NEKKO_TEST_LABEL || 'run'}.png`);
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      report.captures.push(file);
    }
    report.checks.hidden = !win.isVisible();
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
