// Left-rail evidence: the full App fixture at rest and hovered, in both themes,
// plus frames of the open and close motion. Hidden, off-screen, non-focusable;
// hover is a renderer input event, never OS input. Launch through
// layout-evidence-integration.cjs with NEKKO_LAYOUT_SANDBOX=rail-swoop-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const capture = rect => win.capturePage(rect, { stayHidden: true, stayAwake: false });
  const shot = async (name, rect) => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await capture(rect)).toPNG()); report.captures.push(f); };
  const move = (x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  const crop = { x: 0, y: 0, width: 560, height: 900 };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run("!!document.querySelector('.rail .nav-item')")); i++) await sleep(200);
    await sleep(900);
    const target = JSON.parse(await run("JSON.stringify((() => { const b = document.querySelector('.rail .nav-item').getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + 20) }; })())"));
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme = '${theme}'`);
      move(900, 450); await sleep(900);
      await shot(`rail-rest-${theme}`, crop);
      move(target.x, target.y); await sleep(900);
      await shot(`rail-open-${theme}`, crop);
      report.metrics[theme] = JSON.parse(await run("JSON.stringify((() => { const r = document.querySelector('.rail'); const p = document.querySelector('.rail-backdrop path'); return { railWidth: Math.round(r.getBoundingClientRect().width), hovered: r.matches(':hover'), d: p ? getComputedStyle(p).d.slice(0, 120) : null }; })())"));
    }
    // Motion, light theme: frames while opening, then while closing.
    for (const phase of ['open', 'close']) {
      const dir = path.join(out, `motion-${phase}`);
      fs.mkdirSync(dir, { recursive: true });
      if (phase === 'open') { move(900, 450); await sleep(900); move(target.x, target.y); }
      else { move(target.x, target.y); await sleep(900); move(900, 450); }
      const t0 = Date.now();
      for (let i = 0; i < 24; i++) {
        fs.writeFileSync(path.join(dir, String(i).padStart(3, '0') + '.png'), (await capture(crop)).toPNG());
        await sleep(Math.max(0, t0 + (i + 1) * 33 - Date.now()));
      }
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
