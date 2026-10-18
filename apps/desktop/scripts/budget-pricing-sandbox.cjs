const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use wall-polish-integration.cjs');
const dir = path.join(out, process.env.NEKKO_TEST_REVISION ? 'budget-before' : 'budget-after');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1400, height: 1000, show: false, focusable: false, skipTaskbar: true, title: 'Budget pricing isolated evidence', x: Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) - 3000, y: -2000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const report = { checks: [], errors: [] };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (const width of [1400, 760]) for (const theme of ['dark', 'light']) {
      win.setContentSize(width, 1000);
      await run(`integration.reset({dock:true});document.documentElement.dataset.theme='${theme}'`);
      await sleep(900);
      await run("document.querySelector('.monitors-dock__budget details').open=true");
      await sleep(200);
      const budget = await run("!!document.querySelector('.monitors-dock__budget select')");
      report.checks.push({ width, theme, budget });
      if (!budget) throw Error(`Budget selector missing at ${width}px in ${theme}`);
      fs.writeFileSync(path.join(dir, `budget-${width}-${theme}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    }
    if (win.isFocused()) throw Error('Fixture focused');
  } catch (e) { report.errors.push(String(e)); }
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ dir, ...report }));
  if (process.env.NEKKO_INSPECT_HOLD) {
    await run("document.documentElement.dataset.theme='dark'");
    win.showInactive();
    console.log('Holding off-screen non-focusable fixture for pixel inspection');
    await sleep(90000);
  }
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
