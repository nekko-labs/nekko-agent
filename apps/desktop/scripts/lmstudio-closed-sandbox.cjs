// A closed LM Studio on the Models page (#2961): the card asks to open it, and
// only the click starts it. Every bridge call is a stub: nothing reaches a real
// server or runs `lms`. Launch through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_SANDBOX=lmstudio-closed-sandbox.cjs.
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
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  // Offscreen frames do not advance CSS animations: show each one's end state.
  const shot = async name => { await run('document.getAnimations().forEach(a => a.finish())'); win.webContents.invalidate(); await sleep(250); const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.captures.push(f); };
  fs.cpSync(path.join(__dirname, '../src/renderer/public/providers'), path.join(out, 'providers'), { recursive: true });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => {
      const providers = [{id:'lms',kind:'lmstudio',label:'LM Studio',enabled:true,baseUrl:'http://localhost:1234/v1'}];
      const lms = window.__lms = { running: false, starts: 0 };
      const status = () => ({ kind:'lmstudio', running: lms.running, installed: true, owned: false, version: '0.3.27', baseUrl: providers[0].baseUrl, resident: [] });
      window.nekko.listProviders = async () => providers;
      window.nekko.testProvider = async () => lms.running ? { ok: true } : { ok: false, message: 'Could not reach LM Studio at http://localhost:1234/v1.' };
      window.nekko.listModelsStatus = async (id) => lms.running ? { models: [{ id: 'qwen/qwen3-8b', providerId: id, name: 'Qwen3 8B' }] } : { models: [], error: 'fetch failed' };
      window.nekko.lmsAvailable = async () => ({ available: true });
      window.nekko.runtimeStatus = async () => status();
      window.nekko.runtimeFacts = async () => lms.running ? [{ id: 'qwen/qwen3-8b', providerId: providers[0].baseUrl, weightsBytes: 5e9, loaded: false }] : [];
      window.nekko.runtimeStart = async () => { lms.starts++; await new Promise(r => setTimeout(r, 400)); lms.running = true; return status(); };
      window.nekko.engineCatalog = async () => [];
      window.nekko.listModelFolders = async () => [];
      window.nekko.engineModels = async () => [];
      window.nekko.engineDownloads = async () => [];
      window.nekko.engineStatus = async () => ({install:{available:[]},running:false,resident:[],loading:[],log:[],settings:{port:11500,bind:'local',autoload:[]}});
      layoutFixture.store.setState({ providers, activeModelId:'fixture', view:'modelserver' });
    })()`);
    const findCard = `(() => { const el = document.querySelector('[data-testid=lmstudio-open-ask]')?.parentElement ?? document.querySelector('.models-local-connections'); el?.scrollIntoView({ block: 'center' }); return el?.getBoundingClientRect().top ?? null; })()`;
    for (const width of [1440, 390]) {
      win.setContentSize(width, 900);
      await run("layoutFixture.store.getState().setView('modelserver')");
      await sleep(1200);
      report.metrics['card-' + width] = await run(findCard);
      await sleep(300);
      await shot(`lmstudio-closed-${width}`);
    }
    win.setContentSize(1440, 900);
    await sleep(500);
    report.metrics.askShown = await run("!!document.querySelector('[data-testid=lmstudio-open-ask]')");
    report.metrics.startsBeforeClick = await run('window.__lms.starts');
    if (report.metrics.askShown) {
      await run("document.querySelector('[data-testid=lmstudio-open-ask] button').click()");
      await sleep(150);
      await shot('lmstudio-opening-1440');
      await sleep(1500);
      report.metrics.startsAfterClick = await run('window.__lms.starts');
      report.metrics.askAfterOpen = await run("!!document.querySelector('[data-testid=lmstudio-open-ask]')");
      await run(findCard);
      await sleep(300);
      await shot('lmstudio-opened-1440');
    }
    report.metrics.bounds = win.getBounds();
    report.metrics.visible = win.isVisible();
  } catch (e) { report.failed = true; report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(!report.failed && report.captures.length >= 2 ? 0 : 1);
});
