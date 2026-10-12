// Hidden, non-focusable, network-blocked window. Drags the wall composer wider
// than the windows above it, leaves the page and comes back, and records where
// its edges sit relative to the windows. Launch through
// wall-composer-size-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_COMPONENT_OUT;
if (!out) throw Error('Launch through wall-composer-size-integration.cjs');
const kind = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const runDir = path.join(out, kind);
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const report = { kind, checks: [], errors: [], measurements: {}, captures: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1600, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: `Wall composer size ${kind} · isolated`, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Verification window became visible'));
  win.on('focus', () => report.errors.push('Verification window took OS focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const capture = async (name) => { await sleep(400); const file = path.join(runDir, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  // Edges of the outermost windows and of the composer, in CSS pixels.
  const edges = () => run(`(() => {
    const wins = [...document.querySelectorAll('.command-wall-window')].map(w => w.getBoundingClientRect()).filter(r => r.width > 0);
    const c = document.querySelector('[data-wall-composer]').getBoundingClientRect();
    return { windowsLeft: Math.round(Math.min(...wins.map(r => r.left))), windowsRight: Math.round(Math.max(...wins.map(r => r.right))), composerLeft: Math.round(c.left), composerRight: Math.round(c.right), composerWidth: Math.round(c.width), composerHeight: Math.round(c.height) };
  })()`);
  // A real pointer drag on the composer's right-hand width grip, via the DOM's pointer events.
  const drag = (dx, edge = 'right') => run(`(() => {
    const grip = document.querySelector('.wall-composer-side[data-edge="${edge}"]');
    const r = grip.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    grip.setPointerCapture = () => {};
    const ev = (type, cx) => grip.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: cx, clientY: y, pointerId: 1 }));
    ev('pointerdown', x); for (let i = 1; i <= 10; i++) ev('pointermove', x + (${dx} * i) / 10); ev('pointerup', x + ${dx});
  })()`);
  const dragHeight = (dy) => run(`(() => {
    const grip = document.querySelector('.wall-composer-split');
    const r = grip.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    grip.setPointerCapture = () => {};
    const ev = (type, cy) => grip.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: cy, pointerId: 2 }));
    ev('pointerdown', y); for (let i = 1; i <= 10; i++) ev('pointermove', y + (${dy} * i) / 10); ev('pointerup', y + ${dy});
  })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1500);
    if (!await run("!!document.querySelector('[data-wall-composer]') && document.querySelectorAll('.command-wall-window').length >= 2")) throw Error('Fixture did not mount: ' + await run('document.body.textContent.slice(0,300)'));
    report.measurements.initial = await edges();
    await capture('1-initial');
    // Widen far past the windows (the user dragged to the limit), and make it taller.
    await drag(800); await sleep(300);
    await dragHeight(-120); await sleep(300);
    report.measurements.stretched = await edges();
    await capture('2-stretched');
    // Leave the page and come back, as switching to Skills and back does.
    await run("window.integration.page('other')"); await sleep(500);
    await capture('3-other-page');
    await run("window.integration.page('command')"); await sleep(2500);
    report.measurements.returned = await edges();
    await capture('4-returned');
    const s = report.measurements.stretched, r = report.measurements.returned;
    report.checks.push(`stretched: composer ${s.composerLeft}..${s.composerRight}, windows ${s.windowsLeft}..${s.windowsRight} (left off by ${s.composerLeft - s.windowsLeft}px, right off by ${s.composerRight - s.windowsRight}px)`);
    report.checks.push(`after leaving and returning: width ${r.composerWidth}px (was ${s.composerWidth}px), height ${r.composerHeight}px (was ${s.composerHeight}px)`);
    report.background = { visible: win.isVisible(), focused: win.isFocused() };
    report.success = !report.errors.length;
  } catch (e) { report.errors.push(String(e)); report.success = false; }
  finally { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
