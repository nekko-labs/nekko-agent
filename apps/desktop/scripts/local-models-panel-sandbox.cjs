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
        await check(`${theme}: local models monitor lists both resident models`, "(()=>{const m=document.querySelector('[data-monitor=\"localModels\"]');return !!m&&m.innerText.includes('Qwen3 8B')&&m.innerText.includes('Gemma 3 27B')})()");
        await check(`${theme}: split placement is called out`, "document.querySelector('[data-monitor=\"localModels\"]').innerText.includes('38/62')");
      }
    }
    if (!base) {
      await run("integration.reset({empty:true})"); await sleep(1500);
      await capture('dock-empty-dark');
      await check('empty: says nothing is loaded', "document.querySelector('[data-monitor=\"localModels\"]')?.innerText.includes('No local model is loaded')");
      // The point of the feature: one click from the panel to that model's own settings.
      await run("integration.reset()"); await sleep(1500);
      await run("document.querySelector('[data-local-model-settings=\"gemma3-27b-q4\"]').click()"); await sleep(2500);
      await check('click: navigates to Nekko Server', "integration.state().view==='modelserver'");
      await check('click: opens the clicked model drawer', "!!document.querySelector('[data-resident-row=\"gemma3-27b-q4\"] [data-engine-load-drawer]')");
      await check('click: other model stays folded', "!document.querySelector('[data-resident-row=\"qwen3-8b-q4\"] [data-engine-load-drawer]')");
      await check('click: drawer is scrolled into view', "(()=>{const r=document.querySelector('[data-resident-row=\"gemma3-27b-q4\"]').getBoundingClientRect();return r.top>=0&&r.top<innerHeight})()");
      await check('click: request consumed', "integration.state().localModelFocus===null");
      await capture('settings-opened');
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter(c => !c.passed);
  console.log(JSON.stringify({ checks: report.checks.length, failed, errors: report.errors, blockedNetwork: report.blockedNetwork.length }, null, 2));
  app.exit(failed.length || report.errors.length ? 1 : 0);
});
