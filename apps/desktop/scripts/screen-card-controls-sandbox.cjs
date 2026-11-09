// Real renderer, synthetic bridge, hidden window and disposable profile only.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, x: -5000, y: -5000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const click = async selector => { await run(`document.querySelector(${JSON.stringify(selector)}).click()`); await sleep(300); };
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, expression) => { await sleep(80); if (!await run(expression)) throw Error(name); report.checks.push(name); };
  const escape = async () => { await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await sleep(100); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await run("localStorage.clear(); localStorage.setItem('fixture.platform', 'win32')");
    await win.reload();
    for (let i = 0; i < 100 && !await run("!!document.querySelector('[data-wall-view-toggle]')"); i++) await sleep(100);
    await sleep(800);
    for (let i = 0; i < 4; i++) { await run("document.querySelector('[aria-modal=true] [aria-label=Close]')?.click()"); await sleep(200); }
    await check('intro dismissed', "!document.querySelector('[aria-modal=true]')");
    await run(`(() => {
      Object.assign(layoutFixture.settings, {guardrails: [], prompts: [], mcpServers: []});
      layoutFixture.store.setState({settings: {...layoutFixture.store.getState().settings, guardrails: [], prompts: [], mcpServers: []}});
      Object.assign(layoutFixture.bridge, { getRemoteStatus: async () => ({enabled:false}), listComputers: async () => [], telemetryStatus: async () => ({configured:false}) });
      window.viewCalls = [];
      const bridge = window.nekkoChrome.displays;
      bridge.toggle = async (id, enabled) => { if (window.failScreenToggle) throw Error('Synthetic failure'); viewCalls.push(['toggle',id,enabled]); screensFixture.state = {...screensFixture.state, displays: screensFixture.state.displays.map(d => d.id === id ? {...d,enabled} : d)}; return screensFixture.state; };
      bridge.setPlacement = async placement => { viewCalls.push(['placement',placement]); screensFixture.state = {...screensFixture.state,placement}; return screensFixture.state; };
      window.originalScreens = screensFixture.state;
    })()`);
    await click('[data-wall-view-toggle]');
    const changed = await run("!!document.querySelector('.screens-enable')");
    await escape();
    for (const width of [1440, 460, 320, 768]) {
      win.setContentSize(width, 900); await sleep(200);
      await click('[data-wall-view-toggle]');
      await shot(`view-${width}`);
      await check(`View fits ${width}`, "(()=>{const p=document.querySelector('[data-wall-view-menu]'),r=p.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&p.scrollWidth<=p.clientWidth})()");
      await escape();
      await click('[aria-label="Agent panel view options"]');
      await shot(`panel-${width}`);
      await click('[data-view-menu-row="show"]');
      await shot(`show-${width}`);
      await check(`Show fits ${width}`, "(()=>{const p=document.querySelector('[data-agent-view-submenu]'),r=p.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&p.scrollWidth<=p.clientWidth})()");
      await escape(); await escape();
    }
    win.setContentSize(460, 900);
    await run("screensFixture.state = {...originalScreens,displays:[originalScreens.displays[0]]}; screensFixture.emit(screensFixture.state)");
    await click('[data-wall-view-toggle]');
    await shot('view-one-screen');
    if (changed) {
      await check('single screen starts collapsed', "!document.querySelector('.screens-enable input').checked && document.querySelector('.screens-reveal').inert");
      await click('.screens-enable input');
      await check('single screen preference can reveal options', "document.querySelector('.screens-enable input').checked && !document.querySelector('.screens-reveal').inert");
      await shot('view-one-expanded');
      await click('.screens-enable input');
    }
    await escape();
    await run("screensFixture.state = originalScreens; screensFixture.emit(originalScreens)");
    await click('[data-wall-view-toggle]');
    if (changed) {
      await run("window.failScreenToggle = true");
      await click('.screens-enable input');
      await check('failed bridge toggle retains disabled preference', "!document.querySelector('.screens-enable input').checked && !document.querySelector('.screens-enable input').disabled");
      await run("window.failScreenToggle = false");
      const frames = [];
      const capture = async () => { const png = (await win.capturePage(undefined,{stayHidden:true})).toPNG(); frames.push(png); fs.writeFileSync(path.join(out, `motion-${frames.length}.png`),png); };
      await capture(); await run("document.querySelector('.screens-enable input').click()");
      for (let i=0;i<15;i++) { await sleep(40); await capture(); }
      await check('enable opens secondary screen', "viewCalls.some(c=>c[0]==='toggle'&&c[1]==='2'&&c[2]===true) && document.querySelector('.screens-enable input').checked");
      await shot('view-expanded');
      await click('[name="screens-placement"]');
      await check('main first placement saved', "viewCalls.some(c=>c[0]==='placement'&&c[1]==='main-first')");
      await run("document.querySelectorAll('[name=screens-placement]')[1].click()");
      await check('balanced placement saved', "screensFixture.state.placement === 'empty-first'");
      await run("document.querySelector('.screens-enable input').click()");
      for (let i=0;i<15;i++) { await sleep(40); await capture(); }
      require('./evidence-gif.cjs')(path.join(out,'screens-reveal.gif'),frames,4);
      report.captures.push(path.join(out,'screens-reveal.gif'));
      await check('disable closes only secondary screens', "viewCalls.some(c=>c[0]==='toggle'&&c[1]==='2'&&c[2]===false) && !viewCalls.some(c=>c[0]==='toggle'&&c[1]==='1') && document.querySelector('.screens-reveal').inert");
      await click('.screens-enable input'); await escape(); await click('[data-wall-view-toggle]');
      await check('screen preference survives reopening', "document.querySelector('.screens-enable input').checked");
      await click('.screens-enable input');
      await run("document.querySelectorAll('[name=view-interface-detail]')[1].click()"); await sleep(100);
      await run("document.querySelector('[name=view-interface-detail]').click()");
      await check('Simple radio persists', "localStorage.getItem('nekko.chatMode') === 'simple' && document.querySelector('[name=view-interface-detail]').checked");
      await run("document.querySelectorAll('[name=view-interface-detail]')[1].click()");
      await check('Detailed radio selected', "document.querySelectorAll('[name=view-interface-detail]')[1].checked");
      await escape(); await click('[aria-label="Agent panel view options"]'); await click('[data-view-menu-row="show"]');
      await check('experience controls removed from panel', "!document.querySelector('[data-agent-view-menu] .mode-seg') && !document.querySelector('[data-view-menu-row=details]')");
      for (const key of ['showModel','showContext','showPullRequests','showGit','showSubagents','showWindows','showUpdated']) {
        await click(`[data-detail=${key}]`);
        await check(`${key} off`, `document.querySelector('[data-detail=${key}]').getAttribute('aria-checked') === 'false'`);
        await click(`[data-detail=${key}]`);
        await check(`${key} on`, `document.querySelector('[data-detail=${key}]').getAttribute('aria-checked') === 'true'`);
      }
      await run("[...document.querySelectorAll('[data-agent-view-submenu] button')].find(b=>b.textContent==='Metadata').click()");
      await check('metadata off reflected in preview', "document.querySelector('[data-detail=showModel]').getAttribute('aria-checked')==='false'");
      await click('[data-detail=showModel]');
      await check('enabling detail restores metadata', "[...document.querySelectorAll('[data-agent-view-submenu] button')].find(b=>b.textContent==='Metadata').getAttribute('aria-checked')==='true'");
      await escape(); await escape(); await click('[aria-label="Agent panel view options"]'); await click('[data-view-menu-row="show"]');
      await check('detail preference survives reopening', "document.querySelector('[data-detail=showModel]').getAttribute('aria-checked')==='true'");
      await escape(); await escape();
      await click('[data-wall-view-toggle]');
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
      await check('reduced motion disables reveal transition', "getComputedStyle(document.querySelector('.screens-reveal')).transitionDuration === '0s'");
      win.webContents.debugger.detach();
      await click('.view-customize'); await sleep(700);
      await check('Customize navigates to Settings without a modal', "layoutFixture.store.getState().view === 'settings' && !!document.getElementById('settings-customize') && !document.querySelector('[aria-modal=true]') && !document.querySelector('[data-wall-view-menu]')");
      await shot('customize-settings');
    } else {
      await escape(); await click('[aria-label="Agent panel view options"]'); await click('[data-view-menu-row="details"]'); await shot('card-details');
    }
    report.window = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  app.exit(report.errors.length ? 1 : 0);
});
