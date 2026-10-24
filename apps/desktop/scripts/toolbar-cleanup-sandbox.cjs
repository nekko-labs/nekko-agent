// The Agents title bar controls (layout switch, snap magnet, Screens, developer
// server controls), closed and with the Screens dropdown hovered open, in both
// themes. Hidden, off-screen, non-focusable; launch through
// layout-evidence-integration.cjs with NEKKO_LAYOUT_SANDBOX=toolbar-cleanup-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
// JSON.stringify leaves <, >, / and U+2028/2029 raw; escape them before splicing into evaluated code.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
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
  const box = async sel => JSON.parse(await run(`JSON.stringify((()=>{const b=document.querySelector(${js(sel)})?.getBoundingClientRect();return b?{x:Math.round(b.left),y:Math.round(b.top),width:Math.round(b.width),height:Math.round(b.height)}:null})())`));
  const shot = async (name, rect) => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run("!!document.querySelector('[data-wall-toolbar]')")); i++) await sleep(200);
    await run("(()=>{const s=layoutFixture.store.getState();layoutFixture.store.setState({settings:{...s.settings,developer:{...(s.settings.developer||{}),serverControls:true}}})})()");
    await run("[...document.querySelectorAll('[aria-label=\"Wall layout\"] button')].find(b=>b.textContent.includes('Dynamic')).click()");
    await sleep(600);
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme=${js(theme)}`);
      for (const snap of [false, true]) {
        await run(`(()=>{const b=document.querySelector('.wall-snap-toggle'); if (b && (b.getAttribute('aria-pressed')==='true')!==${snap}) b.click();})()`);
        await sleep(500);
        await shot(`toolbar-${snap ? 'snap-on' : 'snap-off'}-${theme}`, { x: 640, y: 0, width: 800, height: 46 });
      }
      // Real :hover through renderer input, the way a pointer opens the dropdown.
      const b = await box('[data-screens-button]');
      if (!b) { report.errors.push('no Screens button'); continue; }
      win.webContents.sendInputEvent({ type: 'mouseMove', x: b.x + b.width / 2, y: b.y + b.height / 2 });
      await sleep(400);
      const p = await box('.screens-picker');
      if (!p) report.errors.push(`Screens dropdown did not open on hover (${theme})`);
      // A click after hover-open must leave it open.
      win.webContents.sendInputEvent({ type: 'mouseDown', x: b.x + b.width / 2, y: b.y + b.height / 2, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: b.x + b.width / 2, y: b.y + b.height / 2, button: 'left', clickCount: 1 });
      await sleep(300);
      report[`openAfterClick-${theme}`] = !!(await box('.screens-picker'));
      await shot(`screens-open-${theme}`, { x: 640, y: 0, width: 800, height: 420 });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 600 });
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
      await sleep(400);
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
});
