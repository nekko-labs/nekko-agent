// The Model server header, Loaded models and a load filling graphics memory
// (#3119), captured hidden and off-screen. Run against a base revision with
// NEKKO_TEST_SOURCE for the "before" shots.
// Launch: NEKKO_LAYOUT_SANDBOX=model-server-header-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [] };
const GB = 1024 ** 3;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1600, height: 2400, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1900, y: minY - 1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  // From the Model server heading down: the server header and Loaded models.
  // The window is tall enough to hold the section unscrolled (a hidden
  // window does not always repaint after a scroll), and the shot is cropped
  // at the heading.
  const shot = async (name, height = 520) => {
    const [width, view] = win.getContentSize();
    const top = await run(`(() => { const h = [...document.querySelectorAll('h2')].find(e => e.textContent === 'Model server'); return h ? Math.max(0, Math.round(h.getBoundingClientRect().top) - 14) : 0; })()`);
    (report.metrics.tops ||= []).push([name, top]);
    win.webContents.invalidate();
    await sleep(150);
    const f = path.join(out, name + '.png');
    fs.writeFileSync(f, (await win.capturePage({ x: 0, y: top, width, height: Math.min(height, view - top) }, { stayHidden: true, stayAwake: true })).toPNG());
    report.captures.push(f);
  };
  const set = async (patch) => {
    await run(`Object.assign(window.__engine, ${JSON.stringify(patch)})`);
    await run(`layoutFixture.store.getState().setView('settings')`);
    for (let i = 0; i < 40 && (await run(`!!document.querySelector('[data-running-models]')`)); i++) await sleep(100);
    await run(`layoutFixture.store.getState().setView('modelserver')`);
    for (let i = 0; i < 40 && !(await run(`!!document.querySelector('[data-running-models]')`)); i++) await sleep(100);
    // The page stays mounted and polls every 6 s: wait one poll.
    await sleep(6600);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    // Detailed mode, where the server settings show.
    await run(`localStorage.setItem('nekko.chatMode', 'expert')`);
    await win.webContents.reload();
    await sleep(300);
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => {
      const engine = { running: true, install: { binPath: '/x/llama-server', source: 'managed', version: 'b11149', backend: 'cuda', available: [] },
        diffusionInstall: { binPath: '/x/sd', source: 'managed', version: 'master-929-3f8527a', available: [] },
        mlxInstall: { available: [] },
        resident: [], loading: [], log: ['00:12:03 Engine listening on 127.0.0.1:11500.', '00:14:40 Loaded qwen3-8b-q4 on port 52114.'],
        memory: { budgetBytes: ${12 * GB}, kind: 'vram' },
        settings: { port: 11500, bind: 'local', autoload: [], autoStart: true, jitLoad: true, idleTtlSeconds: 900, maxLoaded: 2 } };
      window.__engine = engine;
      window.nekko.engineStatus = async () => window.__engine;
      window.nekko.engineModels = async () => [
        { id: 'qwen3-8b-q4', name: 'Qwen3 8B', quantization: 'Q4_K_M', loaded: false, managed: true, sizeBytes: ${5.03 * GB}, maxContext: 40960 },
        { id: 'gemma-27b-q4', name: 'Gemma 3 27B', quantization: 'Q4_K_M', loaded: false, managed: true, sizeBytes: ${16.5 * GB}, maxContext: 131072 },
      ];
      window.nekko.testProvider = async () => ({ ok: true });
      window.nekko.listModelsStatus = async () => ({ models: [] });
      window.nekko.engineDownloads = async () => [];
      window.nekko.engineCatalog = async () => [];
      window.nekko.listModelFolders = async () => [];
      window.nekko.engineSettingsSave = async (p) => { Object.assign(window.__engine.settings, p); return window.__engine.settings; };
      layoutFixture.store.setState({ view: 'settings' });
    })()`);
    await sleep(300);
    const now = Date.now();
    for (const width of [1600, 390]) {
      win.setContentSize(width, width === 390 ? 2600 : 2400);
      await set({ resident: [], loading: [] });
      await shot(`idle-${width}`, width === 390 ? 700 : 520);
      // A load half way in on a 12 GB card, 2 GB held by other apps.
      await set({ loading: [{ id: 'qwen3-8b-q4', phase: 'loading', startedAt: now - 9000, progress: 0.52,
        vram: { totalBytes: 12 * GB, beforeBytes: 10 * GB, freeBytes: 7.2 * GB, needBytes: 5.4 * GB } }] });
      await shot(`loading-${width}`, width === 390 ? 700 : 520);
    }
    win.setContentSize(1600, 2400);
    // One that needs more than the card has free.
    await set({ loading: [{ id: 'gemma-27b-q4', phase: 'loading', startedAt: now - 20000, progress: 0.6,
      vram: { totalBytes: 12 * GB, beforeBytes: 10 * GB, freeBytes: 2.1 * GB, needBytes: 17.2 * GB } }] });
    await shot('loading-over-1600');
    // A model in memory.
    await set({ loading: [], resident: [{ id: 'qwen3-8b-q4', vramBytes: 5.6 * GB, sizeBytes: 5.03 * GB, contextLength: 8192, lastUsedAt: now - 3000, expiresAt: now + 14 * 60000, loadedOn: 'gpu' }] });
    await shot('loaded-1600');
    await set({ resident: [], loading: [] });
    // Configure, if this revision has it: open it and capture the fold.
    const hasConfigure = await run(`!!document.querySelector('[data-model-server-configure]')`);
    report.metrics.hasConfigure = hasConfigure;
    if (hasConfigure) {
      report.metrics.foldInertClosed = await run(`document.getElementById('model-server-configure').inert`);
      // Frames of the fold opening, for the recording: scrolled once, then
      // captured as fast as the window allows.
      await shot('configure-frame-00', 700);
      const top = await run(`Math.max(0, Math.round([...document.querySelectorAll('h2')].find(e => e.textContent === 'Model server').getBoundingClientRect().top) - 14)`);
      await run(`document.querySelector('[data-model-server-configure]').click()`);
      for (let i = 1; i < 14; i++) {
        const f = path.join(out, `configure-frame-${String(i).padStart(2, '0')}.png`);
        fs.writeFileSync(f, (await win.capturePage({ x: 0, y: top, width: 1600, height: 700 }, { stayHidden: true, stayAwake: true })).toPNG());
        report.captures.push(f);
      }
      await sleep(400);
      report.metrics.foldInertOpen = await run(`document.getElementById('model-server-configure').inert`);
      report.metrics.groups = await run(`[...document.querySelectorAll('[data-model-server-config] .quiet-group-label')].map(e => e.textContent)`);
      win.setContentSize(1600, 3200);
      await sleep(300);
      await shot('configure-open-1600', 2000);
      report.metrics.overloadSwitch = await run(`(() => { const s = document.querySelector('[role=switch][aria-label="Overload protection"]'); return s && s.getAttribute('aria-checked'); })()`);
    } else {
      const s = await run(`!![...document.querySelectorAll('summary')].find(s => s.textContent === 'Runtimes')`);
      if (s) {
        await run(`[...document.querySelectorAll('summary')].filter(s => /Model server settings|Runtimes|Server logs/.test(s.textContent)).forEach(s => s.click())`);
        win.setContentSize(1600, 3200);
        await sleep(600);
        await shot('configure-open-1600', 2000);
      }
    }
    report.metrics.header = await run(`(() => { const h = [...document.querySelectorAll('h2')].find(e => e.textContent === 'Model server'); return h && h.parentElement.textContent; })()`);
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
});
