// Actual App focus-control evidence. Isolated profile, no host or network.
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
  const win = new BrowserWindow({ title: 'Gentleface focus isolated evidence', width: 1440, height: 900, useContentSize: true, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [] };
  win.on('show', () => report.errors.push('Window shown'));
  win.on('focus', () => report.errors.push('Window focused'));
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = async (code, label) => { if (!await run(code)) throw Error(label); report.checks.push(label); };
  const capture = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(2000);
    const cdp = win.webContents.debugger; cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await run("document.querySelector('.zones-intro button[aria-label=Close]')?.click()");
    await run("document.querySelector('button[title=\"Dynamic (Ctrl+Shift+2)\"]')?.click()");
    await sleep(700);
    for (const width of [1440, 390]) {
      win.setContentSize(width, 900); await sleep(300); await capture('app-' + width);
    }
    win.setContentSize(1440, 900); await sleep(300);
    await check("document.querySelector('.agent-zen-action') !== null", 'Actual App mounts wall focus control');
    if (!process.env.NEKKO_BEFORE) {
      await check("document.querySelector('.agent-zen-action [data-gf-icon=focus] svg.gf-icon-motion') !== null", 'Actual focus button uses Gentleface motion');
      const b = await run("document.querySelector('.agent-zen-action').getBoundingClientRect().toJSON()");
      await check("(() => { const e = document.querySelector('.agent-zen-action'), b = e.getBoundingClientRect(); return b.width > 0 && e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)); })()", 'Pointer coordinates hit the visible focus action');
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }); await sleep(100);
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x + b.width / 2, y: b.y + b.height / 2 });
      await sleep(80);
      await check("!document.querySelector('.agent-zen-action svg').animationsPaused()", 'Actual focus button animates on pointer entry');
      for (let i = 0; i < 16; i++) { await capture('focus-motion-' + String(i).padStart(2, '0')); await sleep(70); }
      await sleep(1000);
      await check("document.querySelector('.agent-zen-action svg').animationsPaused()", 'Focus motion stops after one play');
      await run("document.querySelector('.agent-zen-action').focus()"); await sleep(80);
      await check("!document.querySelector('.agent-zen-action svg').animationsPaused()", 'Focus button plays on keyboard focus');
      await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await capture('reduced-motion'); await sleep(400);
      await check("matchMedia('(prefers-reduced-motion: reduce)').matches", 'Reduced-motion emulation reaches the renderer');
      await check("document.querySelector('.agent-zen-action svg').animationsPaused()", 'Reduced motion stops the focus animation');
    }
    cdp.detach();
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
