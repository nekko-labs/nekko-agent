// Hidden, non-focusable, off-screen window with its own profile and no network.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT, shots = process.env.NEKKO_SHOTS_OUT, base = !!process.env.NEKKO_TEST_REVISION;
const tag = base ? 'before' : 'after';
app.setPath('userData', path.join(out, 'profile')); app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({ width: 320, height: 600, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { tag, checks: [], errors: [] };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(800);
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(300);
      const order = await run("(()=>{const t=[...document.querySelectorAll('aside section > div:first-child > span:first-child')].map(s=>s.textContent);return t})()");
      report.checks.push({ name: `${theme} section order`, value: order });
      const img = await win.capturePage({ x: 0, y: 0, width: 280, height: 560 }, { stayHidden: true });
      fs.writeFileSync(path.join(shots, `plan-rail-${tag}-${theme}.png`), img.toPNG());
    }
    report.background = { focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e)); }
  finally {
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy(); app.exit(report.errors.length ? 1 : 0);
  }
});
