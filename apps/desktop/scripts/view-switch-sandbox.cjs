// Capture script for layout-evidence-integration.cjs (NEKKO_LAYOUT_SANDBOX=view-switch-sandbox.cjs):
// frames of switching rail views, and of the empty-agent wave at a wide and a narrow size.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const frames = async (dir, count, gap, rect) => {
    fs.mkdirSync(path.join(out, dir), { recursive: true });
    const t0 = Date.now();
    for (let i = 0; i < count; i++) {
      const png = (await win.capturePage(rect, { stayHidden: true })).toPNG();
      fs.writeFileSync(path.join(out, dir, `${String(i).padStart(3, '0')}-${Date.now() - t0}.png`), png);
      await sleep(gap);
    }
    report.captures.push(dir);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run("!!document.querySelector('.rail') && !!document.querySelector('[data-command-wall]')")); i++) await sleep(200);
    const nekkoDark = () => run("(()=>{const f=layoutFixture.store;f.setState({settings:{...f.getState().settings,themePreset:'nekko-dark'}});f.getState().applyTheme()})()");
    await nekkoDark();
    await sleep(900);
    // NEKKO_TIME_SCALE slows the page's frame clock so a sub-second transition
    // spans many captures; GIF frame times divide by it again.
    const k = Number(process.env.NEKKO_TIME_SCALE || 1);
    report.metrics.timeScale = k;
    if (k !== 1) await run(`(() => { const k = ${k}, p0 = performance.now(), now = performance.now.bind(performance), raf = requestAnimationFrame.bind(window);
      window.__realClock = { now: performance.now, raf: window.requestAnimationFrame }; performance.now = () => p0 + (now() - p0) / k; window.requestAnimationFrame = cb => raf(t => cb(p0 + (t - p0) / k)); })()`);
    // Rail views, each switch filmed for a few seconds.
    const views = JSON.parse(await run("JSON.stringify([...document.querySelectorAll('.rail .nav-item')].map(b=>b.getAttribute('aria-label')||b.textContent.trim()))"));
    report.metrics.views = views;
    for (const [n, i] of [[1, 1], [2, 3], [3, 4]]) {
      if (i >= views.length) continue;
      await run(`document.querySelectorAll('.rail .nav-item')[${i}].click()`);
      await frames(`switch-${n}`, 14, 15);
      await sleep(400);
    }
    if (k !== 1) await run('performance.now = __realClock.now; window.requestAnimationFrame = __realClock.raf; 0');
    // The empty agent's wave, wide then narrow.
    await run('layoutFixture.showGreeting()');
    await sleep(600);
    await nekkoDark(); // showGreeting resets the fixture settings
    await sleep(600);
    // Synthetic app focus so the wave runs; the real desktop focus is never taken.
    await run("Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true }); window.dispatchEvent(new Event('focus')); 0");
    await sleep(300);
    report.metrics.wave = JSON.parse(await run("JSON.stringify([...document.querySelectorAll('.pixel-wave-canvas, .pixel-wave-texture')].map(e => ({ tag: e.tagName, w: e.width, h: e.height, cw: e.clientWidth, ch: e.clientHeight, step: e.dataset.step })))"));
    report.metrics.reveal = await run("document.querySelector('.view-reveal')?.style.visibility ?? null");
    await frames('wave-wide', 24, 150);
    report.metrics.waveStepAfterWide = await run("document.querySelector('.pixel-wave-canvas')?.dataset.step ?? null");
    win.setContentSize(460, 800);
    await sleep(800);
    await frames('wave-narrow', 24, 150);
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
