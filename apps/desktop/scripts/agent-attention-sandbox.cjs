// Agents panel evidence: one agent waiting on you, one working, one idle, in
// both themes, plus the view menu's Show submenu. Hidden, off-screen,
// non-focusable. Launch through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_SANDBOX=agent-attention-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async (name, rect) => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  const ready = async () => { for (let i = 0; i < 50 && !(await run("!!document.querySelector('[title=\"View options: group, sort and show\"]')")); i++) await sleep(200); await sleep(900); };
  const crop = { x: 0, y: 0, width: 520, height: 420 };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await ready();
    await run(`localStorage.setItem('fixture.pending', JSON.stringify({ b: {} })); localStorage.setItem('fixture.running', JSON.stringify(['c'])); location.reload()`).catch(() => {});
    await sleep(500); await ready();
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme = '${theme}'`);
      await sleep(400);
      await shot(`agents-${theme}`, crop);
    }
    await run(`document.querySelector('[title="View options: group, sort and show"]').click()`);
    await sleep(300);
    await run(`document.querySelector('[data-view-menu-row="show"]')?.click()`);
    await sleep(400);
    await shot('view-menu-light', { x: 0, y: 0, width: 760, height: 420 });
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
