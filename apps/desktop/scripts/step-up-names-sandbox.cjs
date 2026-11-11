// Captures step-up-names-fixture.tsx at rest and with the code app's Rename open. Hidden, off-screen, non-focusable.
// NEKKO_LAYOUT_FIXTURE=step-up-names-fixture.tsx NEKKO_LAYOUT_SANDBOX=step-up-names-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [], rows: null, renameOpened: false };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 680, height: 640, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 800, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(2500);
    report.rows = JSON.parse(await run(`JSON.stringify([...document.querySelectorAll('[data-method]')].map(r => r.querySelector('.font-medium')?.textContent))`));
    await shot('step-up-names');
    // A DOM click, not OS input: the base branch has no Rename, so this only opens on the change.
    report.renameOpened = await run(`(() => { const b = [...document.querySelectorAll('[data-method="totp"] button')].find(x => x.textContent.trim() === 'Rename'); if (!b) return false; b.click(); return true; })()`);
    if (report.renameOpened) {
      await sleep(300);
      await shot('step-up-names-rename');
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ errors: report.errors, rows: report.rows, renameOpened: report.renameOpened }));
  app.exit(report.captures.length ? 0 : 1);
});
