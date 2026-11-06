// Hidden full-App evidence for an empty zone's placeholder: one agent zone and one empty zone.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { errors: [], captures: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -1700, y: -1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async (name, rect) => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG()); report.captures.push(file); };
  win.on('focus', () => report.errors.push('took focus'));
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!window.layoutFixture && !!document.querySelector("[data-command-wall]")'); i++) await sleep(200);
    await run(`localStorage.setItem('nekko.commandWall',JSON.stringify({layout:{mode:'grid',cols:2,rows:1},zones:true,zonesIntro:true,activeZone:'pane_z',root:{id:'split_fixture',dir:'row',sizes:[0.5,0.5],children:[{id:'pane_a',kind:'chat',refId:'a',zone:'Zone 1'},{id:'pane_z',kind:'zone',refId:'pane_z',zone:'Zone 2'}]},watermark:Date.now(),autoAdd:false,hero:'a'})); location.reload()`);
    await sleep(2500);
    if (!await run(`!!document.querySelector('[data-zone-empty]')`)) throw Error('no empty zone');
    await shot('board');
    const r = await run(`(() => { const b = document.querySelector('[data-zone-empty]').getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
    await shot('zone', r);
    // Hover each option in turn, then press the last one; framed to the zone, written as a GIF.
    const centerOf = kind => run(`(() => { const b = document.querySelector('[data-zone-create=${kind}]')?.getBoundingClientRect(); return b && { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    const frames = [];
    const grab = async (n, every = 30) => { for (let i = 0; i < n; i++) { frames.push((await win.capturePage(r, { stayHidden: true })).toPNG()); await sleep(every); } };
    await grab(4);
    for (const kind of ['chat', 'image', 'terminal']) {
      const c = await centerOf(kind);
      if (!c) continue;
      win.webContents.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y });
      await grab(10);
      if (kind === 'chat') await shot('zone-hover', r);
    }
    const t = await centerOf('terminal');
    if (t) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: t.x, y: t.y, button: 'left', clickCount: 1 });
      await grab(6);
      await shot('zone-press', r);
      // Released off the button so the capture ends on the zone, not a new terminal.
      win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x + 4, y: r.y + 4 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x + 4, y: r.y + 4, button: 'left', clickCount: 1 });
      await grab(10);
    }
    require('./evidence-gif.cjs')(path.join(out, 'zone-motion.gif'), frames, 4);
    report.bounds = win.getBounds(); report.hidden = !win.isVisible();
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ errors: report.errors, bounds: report.bounds, hidden: report.hidden }, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
