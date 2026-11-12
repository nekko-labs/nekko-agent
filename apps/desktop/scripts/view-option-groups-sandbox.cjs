// Hidden, non-focusable, off-screen window with its own profile and no network.
// Launched by view-option-groups-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT, shots = process.env.NEKKO_SHOTS_OUT, base = !!process.env.NEKKO_TEST_REVISION;
if (!out) throw Error('Launch through view-option-groups-integration.cjs');
const tag = base ? 'before' : 'after';
app.setPath('userData', path.join(out, 'profile')); app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 520, height: 1300, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { tag, checks: {}, captures: [], errors: [] };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(String(e.message).slice(0, 300)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  try {
    for (const screens of ['1', '2']) {
      await win.loadFile(path.join(out, 'index.html'), { query: { screens } });
      await sleep(1200);
      // Measured gap from the last placement option to the first desktop option, and the labels in between.
      report.checks[`screens-${screens}`] = await run(`(()=>{
        const groups=[...document.querySelectorAll('.screens-embedded [role=radiogroup]')];
        const a=groups[0]?.lastElementChild?.getBoundingClientRect(), b=groups[1]?.firstElementChild?.getBoundingClientRect();
        return { groups: groups.map(g=>g.getAttribute('aria-label')), labels: [...document.querySelectorAll('.screens-embedded .quiet-group-label')].map(l=>l.textContent), gapPx: a&&b ? Math.round(b.top-a.bottom) : null };
      })()`);
      const r = await run(`(()=>{const b=document.querySelector('[data-shot="view-menu"]').getBoundingClientRect();return {x:Math.floor(b.left),y:Math.floor(b.top),width:Math.ceil(b.width),height:Math.ceil(b.height)}})()`);
      const f = path.join(shots, `view-menu-${screens}-screen-${tag}.png`);
      fs.writeFileSync(f, (await win.capturePage({ x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 }, { stayHidden: true })).toPNG());
      report.captures.push(f);
    }
    report.background = { focused: win.isFocused(), visible: win.isVisible() };
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  finally {
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy(); app.exit(report.captures.length ? 0 : 1);
  }
});
