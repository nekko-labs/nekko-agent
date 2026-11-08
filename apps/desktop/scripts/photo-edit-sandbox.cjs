// Captures photo-edit-fixture.tsx (or its before version) hidden, off-screen
// and non-focusable, once the picture and, after, the edit offer are drawn.
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
  const win = new BrowserWindow({ width: 900, height: 1500, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const settle = async probe => { for (let i = 0; i < 60 && !(await run(probe)); i++) await sleep(150); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    report.bounds = win.getBounds();
    await settle("!!document.querySelector('img[alt^=\"Generated\"]')");
    if (process.env.NEKKO_PHOTO_BEFORE !== '1') await settle("!!document.querySelector('[data-photo-setup=choose]')");
    await sleep(500);
    report.checks.editButtons = await run("document.querySelectorAll('[data-edit-image]').length");
    report.checks.offer = await run("document.querySelector('[data-edit-offer]')?.innerText.split('\\n')[0] ?? null");
    report.checks.cards = await run("[...document.querySelectorAll('[data-photo-model]')].map(b=>b.dataset.photoModel)");
    const f = path.join(out, 'photo-edit.png');
    fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(f);
  } catch (e) { report.errors.push(String(e)); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  win.destroy(); app.exit(process.exitCode || 0);
});
