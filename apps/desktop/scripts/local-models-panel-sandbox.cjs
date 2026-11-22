// Synthetic renderer-only evidence. No host, user profile, OS input or network.
// The window is hidden, non-focusable and parked off every display.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with local-models-panel-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.mkdirSync(dir, { recursive: true });
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const report = { revision: process.env.NEKKO_TEST_REVISION || 'working-tree', checks: [], errors: [], captures: [], blockedNetwork: [] };
  session.defaultSession.webRequest.onBeforeRequest((r, done) => {
    const cancel = !/^(file:|data:|blob:)/.test(r.url);
    if (cancel) report.blockedNetwork.push(r.url);
    done({ cancel });
  });
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4500, y: -3000, title: 'Isolated local models panel verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, source) => { report.checks.push({ name, passed: !!await run(source) }); };
  const capture = async name => {
    const file = path.join(dir, name + '.png');
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw Error('Empty capture: ' + name);
    fs.writeFileSync(file, image.toPNG()); report.captures.push({ file, size: image.getSize() });
  };
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(1000);
    for (const theme of ['dark', 'light']) {
      win.setContentSize(1440, 900);
      await run("integration.reset()"); await sleep(1500);
      await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(400);
      await capture(`dock-${theme}`);
      await check(`${theme}: dock renders`, "!!document.querySelector('.monitors-dock')");
      if (!base) {
        await check(`${theme}: lists the chat and the picture model`, "(()=>{const m=document.querySelector('[data-monitor=\"localModels\"]');return !!m&&m.innerText.includes('Gemma 3 27B')&&m.innerText.includes('FLUX.1 schnell')})()");
        await check(`${theme}: split placement is called out`, "document.querySelector('[data-monitor=\"localModels\"]').innerText.includes('38/62')");
        await check(`${theme}: every loaded model has Unload, the picture model too`, "!!document.querySelector('[data-local-model-unload=\"gemma3-27b-q4\"]')&&!!document.querySelector('[data-local-model-unload=\"flux1-schnell-q4\"]')");
        await check(`${theme}: Unload all for two models`, "!!document.querySelector('[data-local-models-unload-all]')");
        await check(`${theme}: starred Qwen offers Load and Settings`, "!!document.querySelector('[data-local-models-group=\"starred\"] [data-local-model-load=\"qwen3-8b-q4\"]')&&!!document.querySelector('[data-local-models-group=\"starred\"] [data-local-model-settings=\"qwen3-8b-q4\"]')");
        await check(`${theme}: recent Phi offers Load`, "!!document.querySelector('[data-local-models-group=\"recent\"] [data-local-model-load=\"phi4-mini-q4\"]')");
      }
    }
    if (!base) {
      await run("integration.reset({empty:true})"); await sleep(1500);
      await capture('dock-empty-dark');
      await check('empty: says nothing is loaded', "document.querySelector('[data-monitor=\"localModels\"]')?.innerText.includes('No local model is loaded')");
      // Unload the picture model from the dock: its row goes, the chat model stays.
      await run("integration.reset()"); await sleep(1500);
      await run("document.querySelector('[data-local-model-unload=\"flux1-schnell-q4\"]').click()"); await sleep(1500);
      await check('unload: the picture model leaves memory', "!document.querySelector('[data-local-model=\"flux1-schnell-q4\"]')&&!!document.querySelector('[data-local-model=\"gemma3-27b-q4\"]')");
      await check('unload: it is offered under Recent', "!!document.querySelector('[data-local-models-group=\"recent\"] [data-local-model-load=\"flux1-schnell-q4\"]')");
      await capture('after-unload');
      // Load a starred model from the dock.
      await run("document.querySelector('[data-local-model-load=\"qwen3-8b-q4\"]').click()"); await sleep(1500);
      await check('load: the starred model is in memory', "!!document.querySelector('[data-local-model=\"qwen3-8b-q4\"]')");
      // One click from the panel to a loaded model's own settings.
      await run("integration.reset()"); await sleep(1500);
      await run("document.querySelector('[data-local-model=\"gemma3-27b-q4\"] [data-local-model-settings]').click()"); await sleep(2500);
      await check('click: navigates to Model Server', "integration.state().view==='modelserver'");
      await check('click: opens the clicked model drawer', "!!document.querySelector('[data-resident-row=\"gemma3-27b-q4\"] [data-engine-load-drawer]')");
      await check('click: drawer is scrolled into view', "(()=>{const r=document.querySelector('[data-resident-row=\"gemma3-27b-q4\"]').getBoundingClientRect();return r.top>=0&&r.top<innerHeight})()");
      await check('click: request consumed', "integration.state().localModelFocus===null");
      await capture('settings-opened');
      // A starred model that is not loaded opens in the library instead.
      await run("integration.reset()"); await sleep(1500);
      await run("document.querySelector('[data-local-models-group=\"starred\"] [data-local-model-settings=\"qwen3-8b-q4\"]').click()"); await sleep(2500);
      await check('starred settings: navigates to Model Server', "integration.state().view==='modelserver'");
      await check('starred settings: opens its library drawer', "!!document.querySelector('[data-library-row=\"qwen3-8b-q4\"] [data-engine-load-drawer]')");
      await check('starred settings: request consumed', "integration.state().localModelFocus===null");
      await capture('starred-settings-opened');
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter(c => !c.passed);
  console.log(JSON.stringify({ checks: report.checks.length, failed, errors: report.errors, blockedNetwork: report.blockedNetwork.length }, null, 2));
  app.exit(failed.length || report.errors.length ? 1 : 0);
});
