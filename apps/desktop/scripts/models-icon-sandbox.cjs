// Real App, stub bridge, disposable profile, no network or visible windows.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Models icon isolated evidence', width: 1440, height: 900, useContentSize: true, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [], layouts: [] };
  win.on('show', () => report.errors.push('Window shown'));
  win.on('focus', () => report.errors.push('Window focused'));
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = async (code, label) => { if (!await run(code)) throw Error(label); report.checks.push(label); };
  const capture = async name => {
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(2000);
    await run(`(async () => { const f = window.layoutFixture; const settings = await f.bridge.updateSettings({showTips:false, firstPromptIntroSeen:true}); f.store.setState({settings}); })()`);
    await sleep(400);
    await run('document.querySelector(\'.zones-intro button[aria-label="Close"]\')?.click()');
    const cdp = win.webContents.debugger; cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    for (const width of [1440, 900, 390]) {
      win.setContentSize(width, 900); await sleep(400);
      await run(`window.layoutFixture.store.getState().setView('command'); document.activeElement?.blur()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: width - 5, y: 5 });
      await sleep(400);
      await capture(`${width}-rest`);
      if (width < 768) continue; // The phone tab bar has no Models shortcut by default.
      await check(`(() => { const s = document.querySelector('.nav-item[aria-label="Models"] svg'); const r = s.getBoundingClientRect(); return r.width === 22 && r.height === 22; })()`, `${width}: Models remains 22px`);
      if (!process.env.NEKKO_BEFORE) {
        await check(`(() => { const s = document.querySelector('.nav-item[aria-label="Models"] svg'); return s.dataset.gentlefaceIcon === 'brain-gear' && s.querySelectorAll('[fill="#8b5cf6"]').length === 1 && s.querySelectorAll('[fill="#a78bfa"]').length === 1; })()`, `${width}: Gentleface brain-gear in violet/lavender`);
      }
      const point = await run(`(() => { const r = document.querySelector('.nav-item[aria-label="Models"]').getBoundingClientRect(); return {x:Math.round(r.x+20), y:Math.round(r.y+r.height/2)}; })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await sleep(500);
      await check(`document.querySelector('.rail').matches(':hover')`, `${width}: real hover opens rail`);
      await capture(`${width}-hover`);
      await run(`document.querySelector('.nav-item[aria-label="Models"]').focus()`);
      await check(`document.activeElement?.getAttribute('aria-label') === 'Models'`, `${width}: keyboard focus retained`);
      await run(`document.querySelector('.nav-item[aria-label="Models"]').click()`); await sleep(600);
      await check(`window.layoutFixture.store.getState().view === 'models' && document.querySelector('.nav-item[aria-label="Models"]').classList.contains('active')`, `${width}: Models navigation and active state retained`);
      await capture(`${width}-active`);
    }
    cdp.detach(); report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
