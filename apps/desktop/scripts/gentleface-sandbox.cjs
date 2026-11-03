const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Gentleface isolated controls', width: 1000, height: 600, useContentSize: true, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [] };
  win.on('show', () => report.errors.push('Window shown'));
  win.on('focus', () => report.errors.push('Window focused'));
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = async (code, label) => { if (!await run(code)) throw Error(label); report.checks.push(label); };
  const capture = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(400);
    const cdp = win.webContents.debugger; cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await run(`document.documentElement.dataset.theme=${JSON.stringify(process.env.NEKKO_THEME || 'dark')}`);
    if (process.env.NEKKO_FULL_APP) {
      await sleep(1200);
      await run("document.querySelector('.zones-intro button[aria-label=Close]')?.click()");
      await sleep(400);
      for (const width of [1440, 390]) {
        win.setContentSize(width, 900); await sleep(300);
        await capture('app-' + width);
      }
      if (!process.env.NEKKO_BEFORE) await check("document.querySelectorAll('svg.gf-icon-motion').length > 0", 'Actual App mounts animated shared controls');
    } else {
    for (const width of [1000, 390]) {
      win.setContentSize(width, 600); await sleep(200); await capture('controls-' + width);
      if (!process.env.NEKKO_BEFORE) {
        await check("[...document.querySelectorAll('svg.gf-icon-motion')].every(s => s.animationsPaused())", 'Idle SVG timelines paused at ' + width);
        await check("document.querySelectorAll('svg.gf-icon-motion').length === 11", 'All shared controls use motion at ' + width);
      }
    }
    win.setContentSize(1000, 600); await sleep(200);
    if (!process.env.NEKKO_BEFORE) {
      const box = await run("JSON.stringify(document.querySelector('[data-name=Send]').getBoundingClientRect().toJSON())");
      const b = JSON.parse(box);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(b.x + 8), y: Math.round(b.y + 8) }); await sleep(100);
      await check("!document.querySelector('[data-name=Send] svg').animationsPaused()", 'Real pointer hover starts the parent control animation');
      for (let i = 0; i < 20; i++) { await capture('motion-' + String(i).padStart(2, '0')); await sleep(90); }
      await sleep(300);
      await check("document.querySelector('[data-name=Send] svg').animationsPaused() && document.querySelector('[data-name=Send] svg').getCurrentTime() < .05", 'Motion plays once and returns to rest');
      await run("document.querySelector('[data-name=Info]').focus()"); await sleep(80);
      await check("!document.querySelector('[data-name=Info] svg').animationsPaused()", 'Keyboard focus plays motion');
      await run("document.querySelector('[data-name=Info]').blur(); document.querySelector('[data-name=Disabled]').dispatchEvent(new Event('pointerenter'))");
      await check("document.querySelector('[data-name=Disabled] svg').animationsPaused()", 'Disabled controls stay still');
      await run("document.querySelector('[data-name=Terminal]').click()"); await sleep(80);
      await check("!document.querySelector('[data-name=Terminal] svg').animationsPaused()", 'Click or touch activation plays motion');
      await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await sleep(100);
      await check("[...document.querySelectorAll('svg.gf-icon-motion')].every(s=>s.animationsPaused())", 'Live reduced-motion preference stops active motion');
      await run("document.querySelector('[data-name=Send]').click()");
      await check("document.querySelector('[data-name=Send] svg').animationsPaused()", 'Reduced motion prevents activation');
      cdp.detach();
      await check("!document.querySelectorAll('[id]').length || new Set([...document.querySelectorAll('[id]')].map(e=>e.id)).size === document.querySelectorAll('[id]').length", 'SVG reference IDs are unique');
    }
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
