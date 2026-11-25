// Loaded models' live memory bar and the load drawer's per-part breakdown
// (#3315), captured hidden and off-screen against a stand-in engine. Run
// against a base revision with NEKKO_TEST_SOURCE for the "before" shots.
// Launch: NEKKO_LAYOUT_SANDBOX=live-memory-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
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
  const shotAt = async (name, selector, height) => {
    const [width, view] = win.getContentSize();
    const top = await run(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? Math.max(0, Math.round(e.getBoundingClientRect().top) - 16) : -1; })()`);
    if (top < 0) { report.errors.push(`no ${selector} for ${name}`); return; }
    win.webContents.invalidate();
    await sleep(350);
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
    // A status read and two live readings.
    await sleep(4500);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`localStorage.setItem('nekko.chatMode', 'expert')`);
    await win.webContents.reload();
    await sleep(300);
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => {
      const GB = ${GB};
      const models = [
        { id: 'qwen3-8b-q4', name: 'Qwen3 8B', quantization: 'Q4_K_M', loaded: true, managed: true, sizeBytes: 5.03 * GB, maxContext: 40960, layers: 36, format: 'gguf',
          preset: { contextTokens: 4 * 16384, parallelSlots: 4, kvCacheDtype: 'q8_0' } },
        { id: 'gemma-12b-q4', name: 'Gemma 3 12B', quantization: 'Q4_K_M', loaded: true, managed: true, sizeBytes: 7.3 * GB, maxContext: 131072, layers: 48, format: 'gguf' },
        { id: 'coder-30b-a3b', name: 'Qwen3 Coder 30B A3B', quantization: 'Q4_K_M', loaded: false, managed: true, sizeBytes: 17.4 * GB, maxContext: 262144, layers: 48, format: 'gguf',
          weightLayout: { expertShare: 0.85, ffnShare: 0, tableShare: 0, experts: 128, expertsUsed: 8 } },
      ];
      const byId = Object.fromEntries(models.map((m) => [m.id, m]));
      window.__gpu = { source: 'nvidia-smi', devices: [{ name: 'NVIDIA GeForce RTX 4090' }], totalMB: 24 * 1024, usedMB: 19.8 * 1024, freeMB: 4.2 * 1024 };
      window.__sys = { cpuPct: 14, cpuCores: 24, memUsedMB: 21.5 * 1024, memTotalMB: 64 * 1024 };
      const engine = { running: true, install: { binPath: '/x/llama-server', source: 'managed', version: 'b12478', backend: 'cuda', available: [] },
        diffusionInstall: { available: [] }, mlxInstall: { available: [] },
        resident: [], loading: [], log: [], port: 11500,
        memory: { budgetBytes: 24 * GB, kind: 'vram' },
        settings: { port: 11500, bind: 'local', autoload: [], autoStart: true, jitLoad: true, idleTtlSeconds: 900, maxLoaded: 3 } };
      window.__engine = engine;
      window.nekko.engineStatus = async () => window.__engine;
      window.nekko.engineModels = async () => models;
      window.nekko.getGpuStats = async () => window.__gpu;
      window.nekko.getSystemStats = async () => window.__sys;
      window.nekko.runtimeRecommend = async () => null;
      // A stand-in planner: weights by size, KV per token per session, a fixed working space.
      window.nekko.runtimePlace = async (_p, id, req) => {
        const m = byId[id];
        const layers = m.layers || 1;
        const kvPerTok = { f16: 144 * 1024, q8_0: 77 * 1024, q4_0: 41 * 1024 }[req.kvCacheDtype] || 144 * 1024;
        const kv = req.contextTokens * req.sessions * kvPerTok;
        const over = 0.6 * GB + 0.05 * GB * req.sessions;
        const expert = m.weightLayout ? m.sizeBytes * m.weightLayout.expertShare / layers : 0;
        const rest = m.sizeBytes / layers - expert;
        let vw = m.sizeBytes, rw = 0, vkv = kv, rkv = 0, ro = 0;
        if (req.runOn === 'hybrid') {
          const g = Math.min(req.gpuLayers, layers);
          vw = g * rest + Math.min(g, Math.max(0, layers - req.cpuMoeLayers)) * expert + (req.moeCacheBytes || 0);
          rw = m.sizeBytes - vw + (req.moeCacheBytes || 0);
          vkv = req.kvOnGpu ? kv * g / layers : 0; rkv = kv - vkv; ro = 0.5 * GB;
        }
        const share = (w, k, o) => ({ weightsBytes: w, kvCacheBytes: k, overheadBytes: o, pinnedBytes: 0 });
        return { verdict: 'fits', unified: false, deviceName: 'NVIDIA GeForce RTX 4090',
          vram: { totalBytes: 24 * GB, otherBytes: 2.4 * GB, availBytes: 21.6 * GB, model: share(vw, vkv, over) },
          ram: { totalBytes: 64 * GB, otherBytes: 18 * GB, availBytes: 44 * GB, model: share(rw, rkv, ro) },
          disk: { tableBytes: 0, overflowBytes: 0 }, spareVramBytes: 1 * GB };
      };
      window.nekko.testProvider = async () => ({ ok: true });
      window.nekko.listModelsStatus = async () => ({ models: [] });
      window.nekko.engineDownloads = async () => [];
      window.nekko.engineCatalog = async () => [];
      window.nekko.listModelFolders = async () => [];
      layoutFixture.store.setState({ view: 'settings' });
    })()`);
    await sleep(300);
    const now = Date.now();
    const qwen = { id: 'qwen3-8b-q4', vramBytes: 6.9 * GB, sizeBytes: 5.03 * GB, contextLength: 4 * 16384, lastUsedAt: now - 3000, expiresAt: now + 14 * 60000, loadedOn: 'gpu',
      params: { contextTokens: 4 * 16384, parallelSlots: 4, kvCacheDtype: 'q8_0' } };
    const gemma = { id: 'gemma-12b-q4', vramBytes: 8.3 * GB, sizeBytes: 7.3 * GB, contextLength: 32768, lastUsedAt: now - 120000, expiresAt: now + 8 * 60000, loadedOn: 'gpu',
      params: { contextTokens: 32768, kvCacheDtype: 'f16' } };
    const coder = { id: 'coder-30b-a3b', sizeBytes: 17.4 * GB, contextLength: 65536, lastUsedAt: now - 1000, loadedOn: 'gpu+cpu',
      params: { contextTokens: 65536, kvCacheDtype: 'q8_0', gpuLayers: 48, cpuMoeLayers: 40 } };
    for (const theme of ['dark', 'light']) {
      for (const width of [1600, 390]) {
        win.setContentSize(width, 2400);
        // Two models in graphics memory and a third on its way in.
        await set({ resident: [qwen, gemma], loading: [{ id: 'coder-30b-a3b', phase: 'loading', startedAt: now - 9000, progress: 0.4,
          vram: { totalBytes: 24 * GB, beforeBytes: 6.6 * GB, freeBytes: 4.2 * GB, needBytes: 5.6 * GB } }] });
        // The page applies the saved theme on a view change, so this goes after it.
        await run(`document.documentElement.setAttribute('data-theme', '${theme}')`);
        await sleep(400);
        report.metrics[`overflow-${theme}-${width}`] = await run('document.documentElement.scrollWidth > innerWidth');
        await shotAt(`loaded-${theme}-${width}`, '[data-running-models]', width === 390 ? 760 : 560);
      }
    }
    win.setContentSize(1600, 2400);
    // A model split between graphics memory and RAM: two bars.
    {
      await run(`window.__gpu = { ...window.__gpu, usedMB: 22.1 * 1024, freeMB: 1.9 * 1024 }; window.__sys = { ...window.__sys, memUsedMB: 38 * 1024 }`);
      await set({ resident: [qwen, coder], loading: [] });
      await shotAt('hybrid-dark-1600', '[data-running-models]', 560);
      // Pointing at one model lights up its part of both bars.
      await run(`(() => { const r = document.querySelector('[data-live-legend-row="coder-30b-a3b"]'); r && r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })()`);
      await sleep(400);
      await shotAt('hybrid-hover-dark-1600', '[data-running-models]', 560);
      report.metrics.dimmed = await run(`[...document.querySelectorAll('[data-segment]')].filter(e => getComputedStyle(e).opacity < 0.5).map(e => e.dataset.segment)`);
    }
    // The load drawer for a model with four parallel sessions.
    await set({ resident: [qwen, gemma], loading: [] });
    await run(`(() => { const row = document.querySelector('[data-resident-row="qwen3-8b-q4"]'); [...row.querySelectorAll('button')].find(b => b.textContent === 'Settings').click(); })()`);
    for (let i = 0; i < 40 && !(await run(`!!document.querySelector('[data-meter] [data-memory-bar], [data-meter] [data-meter-bar]')`)); i++) await sleep(100);
    await sleep(800);
    await shotAt('drawer-sessions-dark-1600', '[data-meter]', 420);
    report.metrics.drawerParts = await run(`[...document.querySelectorAll('[data-meter-part]')].map(e => e.innerText.replace(/\\s+/g, ' '))`);
    report.metrics.contextSlices = await run(`(() => { const s = document.querySelector('[data-meter-bar="vram"] [data-segment="context"]'); return s ? s.children.length : null; })()`);
    report.metrics.livePools = await run(`[...document.querySelectorAll('[data-live-pool]')].map(e => e.dataset.livePool)`);
    report.metrics.legend = await run(`[...document.querySelectorAll('[data-live-legend-row]')].map(e => e.innerText.replace(/\\s+/g, ' '))`);
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
});
