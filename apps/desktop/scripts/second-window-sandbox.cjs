// A second window (another screen) opening: the Focused toolbar's Screens
// button, then a fresh screen window opened from Focused and from Dynamic.
// Hidden, off-screen, non-focusable; launch through
// layout-evidence-integration.cjs with NEKKO_LAYOUT_SANDBOX=second-window-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [], checks: {} };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  const ready = async () => { for (let i = 0; i < 50 && !(await run("!!document.querySelector('[data-wall-toolbar]')")); i++) await sleep(200); await sleep(5000); };
  const wallState = () => run("(()=>{const k=Object.keys(localStorage).find(k=>k.startsWith('nekko.commandWall.display.'));const w=k&&JSON.parse(localStorage.getItem(k));return {layout:w&&w.layout,panes:document.querySelectorAll('.command-wall-window').length,composer:!!document.querySelector('textarea')}})()");
  try {
    // Main window, Focused: is there a Screens button to open a second window from?
    await win.loadFile(path.join(out, 'index.html'));
    await ready();
    await run("[...document.querySelectorAll('[aria-label=\"Wall layout\"] button')].find(b=>b.textContent.includes('Focused')).click()");
    await sleep(600);
    report.checks.focusedHasScreens = await run("!!document.querySelector('[data-screens-button]')");
    await shot('main-focused');
    // A fresh second screen's window, opened from each mode.
    for (const mode of ['focus', 'grid']) {
      await run(`localStorage.clear();localStorage.setItem('fixture.displayId','2');localStorage.setItem('nekko.screenOpenerMode',${js(mode)})`);
      await win.loadFile(path.join(out, 'index.html'));
      await ready();
      report.checks[`screen-${mode}`] = await wallState();
      await shot(`screen-from-${mode}`);
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
});
