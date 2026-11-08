// Captures the Models page fixture hidden, off-screen and non-focusable: the
// recommendations with their picture rows, then each kind filter.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: {}, errors: [], bounds: null };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1280, height: 1000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await sleep(500); const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const settle = async probe => { for (let i = 0; i < 60 && !(await run(probe)); i++) await sleep(150); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    report.bounds = win.getBounds();
    await settle("!!document.querySelector('[data-recommendations]') && document.body.innerText.includes('models')");
    await shot('models-all');
    report.checks.pictureRows = await run("document.querySelectorAll('[data-image-recommendation]').length");
    if (await run("!!document.querySelector('[data-kind-filter]')")) {
      for (const kind of ['image', 'video']) {
        await run(`document.querySelector('[data-kind-filter=${kind}]').click()`);
        await settle("!!document.querySelector('[data-kind-note]')");
        report.checks[kind] = await run("document.querySelector('[data-kind-note]')?.textContent");
        await shot(`models-${kind}`);
      }
    }
  } catch (e) { report.errors.push(String(e)); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  win.destroy(); app.exit(process.exitCode || 0);
});
