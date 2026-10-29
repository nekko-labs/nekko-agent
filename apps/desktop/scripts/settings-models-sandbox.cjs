const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
fs.cpSync(path.join(process.env.NEKKO_TEST_SOURCE || path.resolve(__dirname, '../../..'), 'apps/desktop/src/renderer/public/providers'), path.join(out, 'providers'), { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [] };
const assert = require('node:assert/strict');
const js = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await win.capturePage(undefined, { stayHidden: true }); await sleep(100); const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run("!!document.querySelector('.rail') && !!document.querySelector('[data-command-wall]')")); i++) await sleep(200);
    await run(`(async()=>{
      const b=layoutFixture.bridge;
      b.getRemoteStatus=async()=>({enabled:false,devices:[]});
      b.listConnectors=async()=>[];
      b.getMessagingStatus=async()=>({telegram:{},discord:{},slack:{}});
      b.telemetryStatus=async()=>({configured:false});
      b.oauthStatus=async()=>({connected:false});
      b.listModelsStatus=async()=>({models:[]});
      b.testProvider=async()=>({ok:true});
      b.listProviderModels=async()=>[];
      await b.updateSettings({guardrails:[],hooks:[]});
    })()`);
    for (const width of [1440, 600]) {
      win.setContentSize(width, 900);
      for (const view of ['settings', 'models', 'skills', 'connectors']) {
        await run(`layoutFixture.store.getState().setView(${js(view)})`);
        await sleep(800);
        await shot(`${view}-${width}`);
        report.metrics[`${view}-${width}`] = await run(`(() => { const p=document.querySelector('.settings-page'); const n=document.querySelector('.settings-nav,.models-subnav'); return {pageWidth:p?.getBoundingClientRect().width,mainWidth:document.querySelector('main').clientWidth,navX:n?.getBoundingClientRect().x,overflow:document.documentElement.scrollWidth>innerWidth}; })()`);
        if (view === 'skills' || view === 'connectors') {
          const back = await run(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Back to Settings')); if(!b)return false;b.click();return true})()`);
          report.metrics[`${view}-back-${width}`]=back && await run("layoutFixture.store.getState().view==='settings'");
        }
      }
    }
    win.setContentSize(1440, 900);
    await run("layoutFixture.store.getState().setView('models')"); await sleep(500);
    await run("document.querySelector('[aria-label=\"More providers\"]').click()"); await sleep(500);
    await shot('more-providers-open');
    report.metrics.menu = {};
    const isOpen = () => run("!!document.querySelector('[data-provider-setup]')");
    report.metrics.menu.open = await isOpen();
    report.metrics.menu.setupVisible = await run(`(() => {const b=document.querySelector('[data-provider-setup]').getBoundingClientRect();return b.top>=0 && b.top<innerHeight && b.height>0})()`);
    await run("document.querySelector('[aria-label=\"More providers\"]').click()"); await sleep(200);
    report.metrics.menu.repeatClosed = !(await isOpen());
    await shot('more-providers-repeat');
    await run("document.querySelector('[aria-label=\"More providers\"]').click()"); await sleep(200);
    await shot('more-providers-reopened');
    await run("document.querySelector('[data-provider-setup]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
    report.metrics.menu.insideStaysOpen = await isOpen();
    await run("document.querySelector('.models-section-title').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))"); await sleep(200);
    report.metrics.menu.outsideClosed = !(await isOpen());
    await shot('more-providers-outside');
    await run("document.querySelector('[aria-label=\"More providers\"]').click()"); await sleep(200);
    await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await sleep(200);
    report.metrics.menu.escapeClosed = !(await isOpen());
    report.metrics.bounds = win.getBounds();
    report.metrics.visible = win.isVisible();
    if (!process.env.NEKKO_TEST_SOURCE) {
      assert.equal(win.isVisible(), false, 'verification must remain hidden');
      for (const width of [1440, 600]) {
        for (const view of ['skills', 'connectors']) assert.equal(report.metrics[`${view}-back-${width}`], true);
        for (const view of ['settings', 'models', 'skills', 'connectors']) assert.equal(report.metrics[`${view}-${width}`].overflow, false);
      }
      const settings = report.metrics['settings-1440'], models = report.metrics['models-1440'];
      assert.ok(Math.abs(settings.pageWidth / settings.mainWidth - .8) < .02);
      assert.ok(Math.abs(settings.navX - models.navX) <= 2);
      for (const [check, passed] of Object.entries(report.metrics.menu)) assert.equal(passed, true, check);
      report.passed = true;
    }

  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(process.env.NEKKO_TEST_SOURCE ? (report.captures.length ? 0 : 1) : (report.passed ? 0 : 1));
});
