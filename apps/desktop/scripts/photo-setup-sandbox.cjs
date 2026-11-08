// Captures the Photo chat's empty state (photo-setup-fixture.tsx, or the
// before-fixture) hidden, off-screen and non-focusable, at a full chat width
// and a narrow wall window, plus the download in progress.
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
  const win = new BrowserWindow({ width: 900, height: 860, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await sleep(400); const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const settle = async probe => { for (let i = 0; i < 60 && !(await run(probe)); i++) await sleep(150); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    report.bounds = win.getBounds();
    const after = await run("!!window.photoFixture") && process.env.NEKKO_PHOTO_BEFORE !== '1';
    const ready = after ? "!!document.querySelector('[data-photo-setup=choose]')" : "document.body.innerText.includes('No image models yet')";
    for (const width of [900, 440]) {
      win.setContentSize(width, 860);
      await settle(ready);
      await shot(`photo-empty-${width}`);
    }
    if (after) {
      report.checks.cards = JSON.parse(await run("JSON.stringify([...document.querySelectorAll('[data-photo-model]')].map(b=>({id:b.dataset.photoModel,disabled:b.disabled,checked:b.getAttribute('aria-checked')})))"));
      report.checks.button = await run("document.querySelector('[data-photo-setup] .btn-primary')?.textContent");
      win.setContentSize(900, 860);
      await run("photoFixture.stage('model')");
      await settle("!!document.querySelector('[data-photo-setup=working]')");
      report.checks.progress = await run("document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')");
      await shot('photo-downloading-900');
    }
  } catch (e) { report.errors.push(String(e)); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  win.destroy(); app.exit(process.exitCode || 0);
});
