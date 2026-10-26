// Matched full-App evidence, isolated from user data and external services.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, expression) => { const value = await run(expression); report.checks.push({ name, value }); if (!process.env.NEKKO_TEST_SOURCE && !value) throw Error(name); };
  win.webContents.on('console-message', e => { if(e.level === 'error') report.errors.push(e.message); });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({root:{id:'d-pane',kind:'chat',refId:'d'},hero:'d',watermark:1,autoAdd:false,layout:{mode:'focus'},dock:{show:false},agentPanel:{show:true}}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-clean-start]")'); i++) await sleep(100);
    await sleep(600);
    await shot('new-chat-default');
    // The screenshot's vivid dark theme makes a tinted menu regression obvious.
    await run(`(() => { const f=layoutFixture; f.store.setState({settings:{...f.store.getState().settings,theme:'dark',themePreset:'x-blueberry-dark',backgroundAnimation:true}}); })()`);
    await run(`layoutFixture.store.getState().applyTheme()`);
    await sleep(400);
    await check('wave is confined to clean-start', `document.querySelectorAll('.pixel-wave-background').length === 1 && !!document.querySelector('[data-clean-start] .pixel-wave-background')`);
    await check('gradient is vertical teal to gold', `getComputedStyle(document.querySelector('.clean-start'),'::before').backgroundImage.includes('rgb(7, 59, 64)') && !getComputedStyle(document.querySelector('.clean-start'),'::before').backgroundImage.includes('135deg')`);
    await shot('new-chat-blueberry');
    fs.mkdirSync(path.join(out, 'motion'), { recursive: true });
    for (let i=0;i<12;i++) { fs.writeFileSync(path.join(out,'motion',String(i).padStart(3,'0')+'.png'),(await win.capturePage(undefined,{stayHidden:true})).toPNG()); await sleep(140); }
    // Real contextmenu event, no OS input or synthetic CSS hover.
    await run(`document.querySelector('[data-chat-surface="full"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:650,clientY:360}))`);
    await sleep(200);
    const hoverPoint = await run(`(() => {const r=document.querySelector('[role="menuitem"]').getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+10)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...hoverPoint});
    await sleep(100);
    await shot('context-dark');
    await check('dark context menu neutral', `getComputedStyle(document.querySelector('[role="menu"]')).backgroundColor === 'rgb(25, 28, 35)'`);
    await check('highlight uses accent', `(() => {const e=document.querySelector('[role="menuitem"]');const probe=document.createElement('span');probe.style.background='var(--accent)';document.body.append(probe);const match=getComputedStyle(e).backgroundColor===getComputedStyle(probe).backgroundColor;probe.remove();return match;})()`);
    await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); layoutFixture.store.setState({settings:{...layoutFixture.store.getState().settings,theme:'light',themePreset:'x-blueberry-white'}})`);
    await run(`layoutFixture.store.getState().applyTheme()`);
    await sleep(200);
    await run(`document.querySelector('[data-chat-surface="full"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:650,clientY:360}))`);
    await sleep(150);
    const lightHoverPoint = await run(`(() => {const r=document.querySelector('[role="menuitem"]').getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+10)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',x:20,y:20});
    win.webContents.sendInputEvent({type:'mouseMove',...lightHoverPoint});
    await sleep(100);
    await shot('context-light');
    await check('light highlight uses accent', `(() => {const e=document.querySelector('[role="menuitem"]');const probe=document.createElement('span');probe.style.background='var(--accent)';document.body.append(probe);const match=getComputedStyle(e).backgroundColor===getComputedStyle(probe).backgroundColor;probe.remove();return match;})()`);
    await check('light context menu neutral', `getComputedStyle(document.querySelector('[role="menu"]')).backgroundColor === 'rgb(255, 255, 255)'`);
    await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); layoutFixture.store.setState({settings:{...layoutFixture.store.getState().settings,theme:'dark',themePreset:'x-blueberry-dark'}})`);
    await run(`layoutFixture.store.getState().applyTheme()`);
    // Many real session summaries force scrolling. Focus requests use the same
    // navigation path as switching to a chat from another tab.
    await run(`(async () => { const f=layoutFixture; const records=Array.from({length:45},(_,i)=>({...f.records[0],id:'row-'+i,title:'Agent '+String(i).padStart(2,'0'),createdAt:Date.now()-i*1000,updatedAt:Date.now()-i*1000,messages:[{id:'m-'+i,role:'user',content:'Review project '+i,createdAt:Date.now()}]})); records.forEach(f.putCachedSession); f.records.push(...records); await f.store.getState().refreshSessions(); f.store.setState({focusRequest:{sessionId:'row-44'}}); })()`);
    for (let i=12;i<20;i++) { fs.writeFileSync(path.join(out,'motion',String(i).padStart(3,'0')+'.png'),(await win.capturePage(undefined,{stayHidden:true})).toPNG()); await sleep(140); }
    await sleep(300);
    await check('existing chat has no pixel wave', `document.querySelectorAll('.pixel-wave-background').length === 0`);
    await shot('selected-agent');
    report.selection = await run(`({rows:[...document.querySelectorAll('[data-agent-active]')].map(e=>({text:e.textContent,rect:e.getBoundingClientRect().toJSON()})),panel:document.querySelector('[data-agent-panel]')?.getBoundingClientRect().toJSON(),count:layoutFixture.store.getState().sessions.length})`);
    await check('selected row is highlighted and revealed', `(() => {const e=document.querySelector('[data-agent-active="true"]');if(!e)return false;const r=e.getBoundingClientRect();return e.textContent.includes('Agent 44') && r.top>=0 && r.bottom<=innerHeight+1;})()`);
    await shot('selected-agent');
    await run(`document.querySelector('[data-sidebar-group]').click(); layoutFixture.store.setState({focusRequest:{sessionId:'row-0'}})`);
    await sleep(500);
    await check('switch expands collapsed group', `document.querySelector('[data-sidebar-group]').getAttribute('aria-expanded') === 'true' && !!document.querySelector('[data-agent-active="true"]')?.textContent.includes('Agent 00')`);
    report.hidden = !win.isVisible(); report.focused = win.isFocused(); report.bounds = win.getBounds();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    report.success = true;
  } catch(e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally { fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
