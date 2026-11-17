// Hover each tooltip target in tooltips-fixture.tsx inside a hidden, off-screen,
// non-focusable window and capture the area around it. A native `title`
// tooltip is drawn by the OS, so it never shows in a capture: a target with
// no tip of ours captures as just the control.
// Run: NEKKO_LAYOUT_FIXTURE=tooltips-fixture.tsx NEKKO_LAYOUT_SANDBOX=tooltips-sandbox.cjs node layout-evidence-integration.cjs
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], tips: {}, errors: [] };
const targets = [
  ['pr-open', '#pr-open a'],
  ['pr-merged', '#pr-merged a'],
  ['issue', '#issue a'],
  ['native-title', '#native-copy'],
  ['hover-tip', '#hover-tip'],
];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 900, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('!!window.tooltipsFixtureReady')); i++) await sleep(200);
    await sleep(1200);
    for (const [name, selector] of targets) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 890, y: 710 });
      await sleep(800);
      const box = JSON.parse(await run(`JSON.stringify((() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })())`));
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) });
      await sleep(900);
      win.webContents.invalidate();
      await sleep(100);
      report.tips[name] = await run("document.querySelector('[role=tooltip]')?.textContent ?? null");
      // A hidden window delivers no frames, so CSS animations never advance on
      // their own: step the tip's entrance by hand for a motion strip, then
      // finish it for the still.
      if (name === 'pr-open' || name === 'native-title') {
        const frames = path.join(out, `motion-${name}`);
        fs.mkdirSync(frames, { recursive: true });
        for (let i = 0; i <= 10; i++) {
          await run(`document.querySelector('[role=tooltip]')?.getAnimations().forEach(a => { a.pause(); a.currentTime = ${i * 20}; })`);
          win.webContents.invalidate();
          await sleep(60);
          fs.writeFileSync(path.join(frames, String(i).padStart(3, '0') + '.png'), (await win.capturePage({ x: Math.max(0, Math.round(box.x - 220)), y: Math.max(0, Math.round(box.y - 150)), width: 520, height: 260 }, { stayHidden: true })).toPNG());
        }
      }
      await run("document.querySelector('[role=tooltip]')?.getAnimations().forEach(a => a.finish())");
      // Without frames the last capture can be stale; repaint a few times first.
      for (let i = 0; i < 5; i++) { win.webContents.invalidate(); await sleep(60); await win.capturePage({ x: 0, y: 0, width: 4, height: 4 }, { stayHidden: true }); }
      const rect = { x: Math.max(0, Math.round(box.x - 220)), y: Math.max(0, Math.round(box.y - 150)), width: 520, height: 260 };
      const file = path.join(out, `tip-${name}.png`);
      fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG());
      report.captures.push(file);
    }
    // The title comes back once the pointer leaves.
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 890, y: 710 });
    await sleep(300);
    report.titleRestored = await run("document.querySelector('#native-copy').getAttribute('title')");
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.exit(report.errors.length ? 1 : 0);
});
