// The Model Server page's two server panels (model server, agent server), both
// running with every runtime installed, captured hidden and off-screen.
// Launch: NEKKO_LAYOUT_SANDBOX=server-panels-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
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
  const win = new BrowserWindow({ width: 1600, height: 1000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1900, y: minY - 1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => {
      const engine = { running: true, install: { binPath: '/x/llama-server', source: 'managed', version: 'b11224', available: [] },
        diffusionInstall: { binPath: '/x/sd', source: 'managed', version: 'master-929-3f8527a', available: [] },
        mlxInstall: { binPath: '/x/mlx', source: 'managed', version: 'mlx-lm 0.31.3', available: [{ id: 'mlx' }] },
        resident: [], loading: [], log: ['server listening on 127.0.0.1:11500'], memory: {},
        settings: { port: 11500, bind: 'local', autoload: [], autoStart: false } };
      let api = { running: true, available: true, clientUrl: 'http://127.0.0.1:1439', clients: 0, requests: 0,
        settings: { enabled: true, startOnLaunch: true, port: 1439, bind: 'local', token: 'tok' } };
      window.nekko.engineStatus = async () => engine;
      window.nekko.engineModels = async () => [{ id: 'qwen3-8b-q4', name: 'Qwen3 8B', loaded: false, managed: true }];
      window.nekko.testProvider = async () => ({ ok: true });
      window.nekko.listModelsStatus = async () => ({ models: [] });
      window.nekko.engineDownloads = async () => [];
      window.nekko.engineCatalog = async () => [];
      window.nekko.listModelFolders = async () => [];
      window.nekko.apiServerStatus = async () => api;
      window.nekko.apiServerSave = async (p) => (api = { ...api, running: p.enabled ?? api.running, settings: { ...api.settings, ...p } });
      window.nekko.runtimeStop = async () => { engine.running = false; return { ok: true }; };
      window.nekko.runtimeStart = async () => { engine.running = true; return engine; };
      window.__api = () => api;
      // Remount the page so its first-mount calls hit these stubs too.
      layoutFixture.store.setState({ view: 'settings' });
    })()`);
    await sleep(300);
    for (const width of [1600, 1100, 390]) {
      win.setContentSize(width, 1000);
      await run(`layoutFixture.store.getState().setView('modelserver')`);
      await sleep(1500);
      await shot(`modelserver-${width}`);
    }
    win.setContentSize(1600, 1000);
    // Header and status rows of the two panels share a top edge at two columns.
    report.metrics.rows = await run(`(() => {
      const top = (re) => [...document.querySelectorAll('h2, span.text-sm')].filter(e => re.test(e.textContent)).map(e => Math.round(e.getBoundingClientRect().top));
      return { titles: top(/^(Model|Agent) server$/), running: top(/^Running$/) };
    })()`);
    // The switches flip what they say they flip.
    const sw = await run(`[...document.querySelectorAll('[role=switch]')].map(e => e.getAttribute('aria-label') + '=' + e.getAttribute('aria-checked'))`);
    report.metrics.switchesBefore = sw;
    if (await run(`!!document.querySelector('[role=switch][aria-label="Stop agent server"]')`)) {
      await run(`document.querySelector('[role=switch][aria-label="Stop agent server"]').click()`);
      await sleep(600);
      report.metrics.agentAfterClick = await run(`window.__api().settings.enabled`);
      report.metrics.switchesAfter = await run(`[...document.querySelectorAll('[role=switch]')].map(e => e.getAttribute('aria-label') + '=' + e.getAttribute('aria-checked'))`);
      await shot('modelserver-agent-stopped-1600');
    }
    const runtimes = await run(`!![...document.querySelectorAll('summary')].find(s => s.textContent === 'Runtimes')`);
    report.metrics.runtimesFolded = await run(`(() => { const s = [...document.querySelectorAll('summary')].find(s => s.textContent === 'Runtimes'); return s ? !s.parentElement.open : null; })()`);
    if (runtimes) {
      await run(`[...document.querySelectorAll('summary')].find(s => s.textContent === 'Runtimes').click()`);
      await sleep(400);
      await shot('modelserver-runtimes-open-1600');
    }
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
});
