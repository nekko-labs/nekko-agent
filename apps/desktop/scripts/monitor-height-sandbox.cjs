// Monitors dock height resize evidence, docked above and below the wall. Run through layout-evidence-integration.cjs.
// NEKKO_TEST_SOURCE can point at an unchanged base tree: it then only captures, since the base has no height handle.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const base = !!process.env.NEKKO_TEST_SOURCE;
const report = { captures: [], sides: {}, errors: [] };
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'Monitors height, isolated evidence', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const measure = () => run(`(() => {
    const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height), x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), width: Math.round(b.width) }; };
    const h = document.querySelector('.monitors-dock [aria-label="Resize monitors"]');
    const hit = h && (() => { const b = h.getBoundingClientRect(); const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e ? (e.className || e.tagName) + (h.contains(e) ? " (handle)" : "") : null; })(); return { hit, hovered: h && h.matches(":hover"), dock: r(".monitors-dock"), wall: r('.wall-agent-workspace'), handle: r('.monitors-dock [aria-label="Resize monitors"]'), cursor: h && getComputedStyle(h).cursor, grip: h && getComputedStyle(h.firstElementChild).opacity, now: h && Number(h.getAttribute('aria-valuenow')), max: h && Number(h.getAttribute('aria-valuemax')) };
  })()`);
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await cdp('Page.enable');
    for (const side of ['top', 'bottom']) {
      await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({ root: { id: 'gradient-pane', kind: 'chat', refId: 'd' }, hero: 'd', watermark: 1, autoAdd: false, layout: { mode: 'focus' }, dock: { show: true, side: ${JSON.stringify(side)} }, agentPanel: { show: true } }));` });
      await win.loadFile(path.join(out, 'index.html'));
      for (let i = 0; i < 60 && !await run(`!!document.querySelector('[aria-label="Show the monitors panel"], .monitors-dock[data-panel-open="true"]')`); i++) await sleep(100);
      await run(`document.querySelector('[aria-label="Show the monitors panel"]')?.click()`);
      for (let i = 0; i < 40 && !await run(`!!document.querySelector('.monitors-dock [aria-label="Configure monitors"]')`); i++) await sleep(100);
      await run(`document.querySelector('.monitors-dock [aria-label="Configure monitors"]').click()`); await sleep(200);
      await run(`[...document.querySelectorAll('.monitors-dock__positions button')].find(b => b.textContent === ${JSON.stringify(side[0].toUpperCase() + side.slice(1))}).click()`); await sleep(200);
      await run(`document.querySelector('.monitors-dock [aria-label="Configure monitors"]')?.click()`);
      for (let i = 0; i < 60 && !await run(`!!document.querySelector('.monitors-dock[data-dock-side="${side}"] .monitors-dock__monitor')`); i++) await sleep(100);
      await sleep(800);
      const r = { initial: await measure() };
      report.sides[side] = r;
      await shot(`${side}-default`);
      if (base) continue;
      if (!r.initial.handle || r.initial.cursor !== 'row-resize') throw Error(`${side}: no row-resize handle`);
      // The handle lies in the gap on the wall side of the dock.
      const edge = side === 'top' ? r.initial.dock.bottom : r.initial.dock.top;
      if (Math.abs(r.initial.handle.y - edge) > 6) throw Error(`${side}: handle is not on the dock's inner edge`);
      const grow = side === 'top' ? 1 : -1;
      const { x, y } = r.initial.handle;
      await mouse('mouseMoved', x, y, { buttons: 0 }); await sleep(250);
      r.hover = await measure();
      await shot(`${side}-hover`);
      // Shrink by 160px.
      await mouse('mousePressed', x, y);
      for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', x, y - grow * 20 * i); await sleep(16); }
      await mouse('mouseReleased', x, y - grow * 160); await sleep(300);
      r.shrunk = await measure();
      await shot(`${side}-shrunk`);
      // Grow back past the default by 300px from the shrunk edge.
      const h = (await measure()).handle;
      await mouse('mousePressed', h.x, h.y);
      for (let i = 1; i <= 15; i++) { await mouse('mouseMoved', h.x, h.y + grow * 20 * i); await sleep(16); }
      await mouse('mouseReleased', h.x, h.y + grow * 300); await sleep(300);
      r.grown = await measure();
      await shot(`${side}-grown`);
      // Double-click resets to the default ceiling.
      const g = (await measure()).handle;
      await mouse('mousePressed', g.x, g.y, { clickCount: 1 }); await mouse('mouseReleased', g.x, g.y, { clickCount: 1 });
      await mouse('mousePressed', g.x, g.y, { clickCount: 2 }); await mouse('mouseReleased', g.x, g.y, { clickCount: 2 }); await sleep(300);
      r.reset = await measure();
      // Keyboard: ArrowUp / ArrowDown move the edge, Home resets.
      const key = async k => { await run(`document.querySelector('.monitors-dock [aria-label="Resize monitors"]').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`); await sleep(120); };
      await key(side === 'top' ? 'ArrowUp' : 'ArrowDown'); await key(side === 'top' ? 'ArrowUp' : 'ArrowDown'); await key(side === 'top' ? 'ArrowUp' : 'ArrowDown');
      r.keyShrunk = await measure();
      await key('Home');
      r.keyHome = await measure();
      if (!(r.shrunk.dock.height < r.initial.dock.height - 100)) throw Error(`${side}: drag did not shrink the dock`);
      if (!(r.grown.dock.height > r.shrunk.dock.height + 100)) throw Error(`${side}: drag did not grow the dock`);
      if (r.grown.dock.height > r.grown.max + 1) throw Error(`${side}: grew past its content or the wall's room`);
      if (r.grown.wall.height < 240) throw Error(`${side}: the wall lost its minimum height`);
      if (r.reset.now !== 360 || r.keyHome.now !== 360) throw Error(`${side}: reset did not return to the default`);
      if (!(r.keyShrunk.dock.height < r.reset.dock.height)) throw Error(`${side}: keyboard did not shrink the dock`);
    }
    report.hidden = !win.isVisible(); report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    report.success = report.errors.length === 0;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'monitor-height-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
