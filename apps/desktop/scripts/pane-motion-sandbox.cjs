// Electron side of pane-motion-integration.cjs. A hidden, unfocusable window on
// a throwaway profile with every network request cancelled: it opens a new
// agent window on a synthetic two-agent wall, then minimizes it, sampling each
// window's box every frame, and saves frames paused at fixed points.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through pane-motion-integration.cjs');
const runDir = path.join(out, new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { timelines: {}, captures: [], errors: [] };

// Samples every wall window (live or leaving) for `ms` after `action` runs.
const SAMPLE = (action, ms) => `new Promise((resolve) => {
  const frames = []; const t0 = performance.now();
  const box = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { id: el.dataset.wallPane, x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y), h: Math.round(r.height), op: +(+s.opacity).toFixed(2), clip: s.clipPath === 'none' ? undefined : s.clipPath, leaving: el.hasAttribute('data-wall-leaving') || undefined }; };
  const tick = () => { const t = Math.round(performance.now() - t0); frames.push({ t, panes: [...document.querySelectorAll('[data-wall-pane]')].filter(el => el.getClientRects().length).map(box), dust: document.querySelectorAll('.completion-stardust').length });
    if (t < ${ms}) requestAnimationFrame(tick); else resolve(frames); };
  ${action}; requestAnimationFrame(tick);
})`;
const OPEN = `document.querySelector('[aria-label="New agent"]').click()`;
const CLOSE = `[...document.querySelectorAll('[aria-label^="Minimize"]')].pop().click()`;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const far = screen.getAllDisplays().map(d => d.bounds);
  const win = new BrowserWindow({ width: 1400, height: 820, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...far.map(b => b.x)) - 1600, y: Math.min(...far.map(b => b.y)) - 1100, title: 'Synthetic pane motion verification', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('Verification window took OS focus'); process.exitCode = 1; });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const capture = async name => { const file = path.join(runDir, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(file); };
  const reset = async () => {
    await run('window.integration.reset()');
    for (let i = 0; i < 50 && !(await run("document.querySelectorAll('[data-wall-pane]').length >= 2")); i++) await sleep(100);
    await sleep(700);
  };
  // Pause every running animation and transition at `at` ms and capture it.
  const frozen = async (action, points, prefix) => {
    for (const at of points) {
      await reset();
      if (prefix === 'close') { await run(OPEN); await sleep(1200); }
      await run(`(${action}, new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
      await run(`(() => { document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).forEach(a => { a.pause(); a.currentTime = ${at}; }); })()`);
      await sleep(120);
      await capture(`${prefix}-${String(at).padStart(3, '0')}ms`);
      await run(`document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).forEach(a => a.finish())`);
    }
  };
  // A clip: every finite animation paused and stepped 20 ms at a time (the
  // same clock for the transitions and the clip reveal), one capture per step.
  const FINITE = `document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime))`;
  const film = async (action, name, ms = 400) => {
    const dir = path.join(runDir, 'film-' + name); fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, `f${String(n++).padStart(3, '0')}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    await run(`(${action}, new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
    for (let t = 0; t <= ms; t += 20) {
      await run(`${FINITE}.forEach(a => { a.pause(); a.currentTime = ${t}; })`);
      await sleep(60);
      fs.writeFileSync(path.join(dir, `f${String(n++).padStart(3, '0')}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    }
    await run(`${FINITE}.forEach(a => a.finish())`);
    for (let i = 0; i < 10; i++) { await sleep(60); fs.writeFileSync(path.join(dir, `f${String(n++).padStart(3, '0')}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); }
    report.films = [...(report.films || []), dir];
  };
  try {
    if (process.env.NEKKO_PANE_FILM) {
      await win.loadFile(path.join(out, 'index.html'));
      win.showInactive(); await sleep(1200);
      await run('window.integration.reset()'); await sleep(900);
      await film(OPEN, 'side-open');
      await sleep(400);
      await film(CLOSE, 'side-close');
      await win.loadFile(path.join(out, 'index.html'), { search: 'multi' }); await sleep(1200);
      await reset();
      await film(OPEN, 'row-open');
      await sleep(400);
      await film(CLOSE, 'row-close');
      return;
    }
    await win.loadFile(path.join(out, 'index.html'), { search: 'multi' });
    win.showInactive();
    await sleep(1200);
    await reset();
    await capture('open-start');
    report.timelines.open = await run(SAMPLE(OPEN, 1100));
    await sleep(400);
    await capture('open-end');
    report.timelines.close = await run(SAMPLE(CLOSE, 1100));
    await sleep(400);
    await capture('close-end');
    await frozen(OPEN, [40, 120, 200, 300], 'open');
    await frozen(CLOSE, [40, 120, 200, 300], 'close');
    // The stardust, live: it starts as the fold lands.
    await reset(); await run(OPEN); await sleep(900);
    await run(CLOSE); await sleep(260); await capture('close-dust-live');
    // A one-window wall: the new window opens sideways, out of its right edge.
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1200);
    await run('window.integration.reset()');
    await sleep(900);
    report.timelines.openSide = await run(SAMPLE(OPEN, 700));
    await sleep(300);
    report.timelines.closeSide = await run(SAMPLE(CLOSE, 700));
    await run('window.integration.reset()'); await sleep(900);
    await run(`(${OPEN}, new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
    await run(`document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).forEach(a => { a.pause(); a.currentTime = 100; })`);
    await sleep(120); await capture('side-open-100ms');
    await run(`document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).forEach(a => a.finish())`);
    await sleep(600);
    await run(CLOSE); await sleep(240); await capture('side-close-dust-live');
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 1));
    console.log(JSON.stringify({ runDir, errors: report.errors, captures: report.captures.length }));
    win.destroy();
    app.quit();
  }
});
