// Settings > Computers, captured hidden. Run through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_FIXTURE=computers-section-fixture.tsx NEKKO_LAYOUT_SANDBOX=computers-section-sandbox.cjs.
// Hidden, off-screen, non-focusable window, isolated profile, network blocked.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], errors: [] };
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  const win = new BrowserWindow({ width: 700, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  try {
    for (const awake of ['0', '1']) {
      await win.loadFile(path.join(out, 'index.html'), { search: `awake=${awake}` });
      await sleep(1200);
      for (let i = 0; i < 2; i++) { win.webContents.invalidate(); await sleep(400); await win.capturePage(undefined, { stayHidden: true }); }
      fs.writeFileSync(path.join(out, `computers-awake-${awake}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      const text = await run('document.body.innerText');
      report.checks.push({ name: `awake=${awake}: the switch shows`, pass: /Keep this computer awake while agents run/.test(text) });
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); process.exitCode = 1; }
  console.log(JSON.stringify(report, null, 2));
  app.exit(process.exitCode || 0);
});
