// The Screens dropdown on one screen with three macOS desktops: the Desktops
// row, the Accessibility explainer with its looping animation (frames for a
// GIF), and the chosen-mode view options. Hidden, off-screen, non-focusable;
// launch through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_SANDBOX=screens-spaces-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [] };
const desk = (n, extra) => ({ id: `space-${n}`, label: String(n), current: n === 1, main: n === 1, enabled: n === 1, waiting: false, self: n === 1, ...extra });
const oneScreen = mode => ({ placement: 'empty-first', displays: [{ id: '1', label: '1', bounds: { x: 0, y: 0, width: 1728, height: 1117 }, main: true, primary: true, enabled: true, self: true, scaleFactor: 2 }],
  spaces: { mode, access: false, desktops: [desk(1), desk(2), desk(3, mode === 'ask' ? {} : { enabled: true, waiting: true })] } });
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const box = async sel => JSON.parse(await run(`JSON.stringify((()=>{const b=document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect();return b?{x:Math.round(b.left),y:Math.round(b.top),width:Math.round(b.width),height:Math.round(b.height)}:null})())`));
  const shot = async (name, rect) => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  const setScreens = s => run(`window.screensFixture.state=${JSON.stringify(s)};window.screensFixture.emit(window.screensFixture.state)`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run("!!document.querySelector('[data-wall-toolbar]')")); i++) await sleep(200);
    await run("[...document.querySelectorAll('[aria-label=\"Wall layout\"] button')].find(b=>b.textContent.includes('Dynamic')).click()");
    await sleep(600);
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await setScreens(oneScreen('ask')); await sleep(200);
      const b = await box('[data-screens-button]');
      if (!b) { report.errors.push('no Screens button'); continue; }
      win.webContents.sendInputEvent({ type: 'mouseMove', x: b.x + b.width / 2, y: b.y + b.height / 2 });
      await sleep(400);
      await shot(`desktops-${theme}`, { x: 720, y: 0, width: 720, height: 420 });
      await run("document.querySelector('[aria-label^=\"Desktop 2\"]').click()");
      await sleep(250);
      const ask = await box('.screens-picker');
      const rect = ask && { x: Math.max(0, ask.x - 8), y: 0, width: Math.min(1440 - Math.max(0, ask.x - 8), ask.width + 16), height: ask.y + ask.height + 8 };
      await shot(`explainer-${theme}`, rect);
      if (theme === 'dark') {
        // 5s loop at ~12 fps for the recording.
        const demo = await box('.spaces-demo');
        fs.mkdirSync(path.join(out, 'demo'), { recursive: true });
        // The hidden window is never focused, so the app marks itself inactive and pauses loops; a real dropdown is open in an active app.
        await run("document.documentElement.removeAttribute('data-app-inactive'); new MutationObserver(()=>document.documentElement.removeAttribute('data-app-inactive')).observe(document.documentElement,{attributes:true,attributeFilter:['data-app-inactive']})");
        await run("document.getAnimations().filter(a=>String(a.animationName||'').startsWith('spaces-demo')).forEach(a=>{a.currentTime=0})");
        const start = Date.now();
        for (let i = 0; Date.now() - start < 5200; i++) {
          fs.writeFileSync(path.join(out, 'demo', String(i).padStart(3, '0') + '.png'), (await win.capturePage({ x: demo.x - 6, y: demo.y - 6, width: demo.width + 12, height: demo.height + 12 }, { stayHidden: true })).toPNG());
          await sleep(60);
        }
      }
      await setScreens(oneScreen('switch')); await sleep(250);
      const chosen = await box('.screens-picker');
      await shot(`chosen-${theme}`, chosen && { x: Math.max(0, chosen.x - 8), y: 0, width: Math.min(1440 - Math.max(0, chosen.x - 8), chosen.width + 16), height: chosen.y + chosen.height + 8 });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 600 });
      await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
      await sleep(400);
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
});
