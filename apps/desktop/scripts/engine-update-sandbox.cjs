// Settings > Engine on an engine older than the pinned release: the update line
// and the one-button priority beside Repair and Switch to CUDA. Captured hidden
// and off-screen. Run against a base revision with NEKKO_TEST_SOURCE for "before".
// Launch: NEKKO_LAYOUT_SANDBOX=engine-update-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [] };
const OLD = 'A newer engine (b12436) is available. Yours is b11224.';
const outdated = { buildId: 'win-x64-cuda', installed: 'b11224', pinned: 'b12436', message: OLD, notify: true };
// A few days behind: the pin moves several times a day, so the card stays quiet unless a model needs the update.
const slight = { buildId: 'win-x64-cuda', installed: 'b12400', pinned: 'b12436', message: 'A newer engine (b12436) is available. Yours is b12400.', notify: false };
const problem = { message: 'The NVIDIA engine is missing its GPU libraries, so models are running on the processor and replies will be very slow or never arrive. Repair it to use your graphics card.', repairBuildId: 'win-x64-cuda' };
const upgrade = (also) => ({ buildId: 'win-x64-cuda', message: 'Your NVIDIA graphics card can run the CUDA engine, which is roughly 15-20% faster than Vulkan. It is a download of several hundred MB.' + (also ? ' It also brings the engine up to date.' : '') });
const states = {
  // The engine is current: nothing to say.
  current: { version: 'b12436' },
  // The case this change is for.
  old: { version: 'b11224', outdated },
  // Same release: one button, the CUDA one, which says it also updates.
  'old-cuda-switch': { version: 'b11224', backend: 'vulkan', upgrade: upgrade(true), outdated },
  // A little behind and nothing needs it: no notice (the rows and the offer still have their Update).
  'slightly-old': { version: 'b12400', outdated: slight },
  // A little behind, but two models in the library are refused for want of a newer engine.
  'old-with-blocked-files': { version: 'b12400', outdated: slight, blockedFiles: 2 },
  // A broken engine: Repair alone.
  'old-broken': { version: 'b11224', problem, outdated },
};
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1600, height: 2400, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1900, y: minY - 1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async (name, height = 520) => {
    const [width, view] = win.getContentSize();
    const top = await run(`(() => { const h = [...document.querySelectorAll('h2')].find(e => e.textContent.trim() === 'Local model server'); return h ? Math.max(0, Math.round(h.getBoundingClientRect().top) - 14) : 0; })()`);
    win.webContents.invalidate();
    await sleep(150);
    const f = path.join(out, name + '.png');
    fs.writeFileSync(f, (await win.capturePage({ x: 0, y: top, width, height: Math.min(height, view - top) }, { stayHidden: true, stayAwake: true })).toPNG());
    report.captures.push(f);
  };
  const set = async ({ blockedFiles = 0, ...patch }) => {
    await run(`window.__blocked = ${blockedFiles}`);
    await run(`window.__engine.install = Object.assign({ binPath: 'C:/x/llama-server.exe', source: 'managed', backend: 'cuda', available: [] }, ${JSON.stringify(patch)})`);
    const onPage = `!![...document.querySelectorAll('h2')].find(e => e.textContent.trim() === 'Local model server')`;
    await run(`layoutFixture.store.getState().setView('settings')`);
    await sleep(200);
    await run(`layoutFixture.store.getState().setView('modelserver')`);
    await sleep(300);
    // The Models page opens on Cloud providers: go to the local server.
    if (!(await run(onPage))) await run(`[...document.querySelectorAll('button, a')].find(e => e.textContent.trim() === 'Local model server')?.click()`);
    for (let i = 0; i < 40 && !(await run(onPage)); i++) await sleep(100);
    // The page stays mounted and polls every 6 s: wait one poll.
    await sleep(6600);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`localStorage.setItem('nekko.chatMode', 'expert')`);
    await win.webContents.reload();
    await sleep(300);
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => {
      window.__engine = { running: false, install: { available: [] }, diffusionInstall: { available: [] }, mlxInstall: { available: [] },
        resident: [], loading: [], log: [], memory: { budgetBytes: 12 * 1024 ** 3, kind: 'vram' },
        settings: { port: 11500, bind: 'local', autoload: [], autoStart: false, jitLoad: true, idleTtlSeconds: 900, maxLoaded: 2 } };
      window.nekko.engineStatus = async () => window.__engine;
      window.__blocked = 0;
      const needsNewer = { level: 'blocked', cause: 'engineAge', reason: 'needs llama.cpp b11556 or newer.' };
      window.nekko.engineModels = async () => [{ id: 'qwen3-8b-q4', name: 'Qwen3 8B', quantization: 'Q4_K_M', loaded: false, managed: true, sizeBytes: 5.03 * 1024 ** 3, maxContext: 40960 },
        ...Array.from({ length: window.__blocked }, (_, i) => ({ id: 'bonsai-' + i, name: 'Ternary Bonsai ' + (i + 1), path: 'C:/m/bonsai-' + i + '.gguf', quantization: 'Q2_0', loaded: false, managed: true, sizeBytes: 7.1 * 1024 ** 3, maxContext: 262144, loadCheck: needsNewer }))];
      window.nekko.testProvider = async () => ({ ok: true });
      window.nekko.listModelsStatus = async () => ({ models: [] });
      window.nekko.engineDownloads = async () => [];
      window.nekko.engineCatalog = async () => [];
      window.nekko.listModelFolders = async () => [];
      window.__installs = [];
      window.nekko.engineInstall = async (id) => { window.__installs.push(id); return { ok: true, message: 'x' }; };
      layoutFixture.store.setState({ view: 'settings' });
    })()`);
    await sleep(300);
    await set(states.old);

    for (const [name, patch] of Object.entries(states)) {
      await set(patch);
      await shot(name);
      report.metrics[name] = await run(`[...document.querySelectorAll('[data-models-section], section')].length && [...document.querySelectorAll('button')].map(b => b.textContent).filter(t => /^(Update|Repair engine|Switch to CUDA|Downloading…)$/.test(t))`);
    }
    // Pressing Update asks for the installed build again and nothing else.
    await set(states.old);
    await run(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Update').click()`);
    await sleep(300);
    report.metrics.installCalls = await run('window.__installs');
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
});
