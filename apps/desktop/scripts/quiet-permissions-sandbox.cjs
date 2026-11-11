// Real App/ChatPane evidence; isolated hidden Electron, synthetic bridge only.
// NEKKO_LAYOUT_SANDBOX=quiet-permissions-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
// Set NEKKO_TEST_SOURCE to the unchanged base checkout and NEKKO_TEST_LABEL=before for baseline.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const writeGif = require('./evidence-gif.cjs');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const before = !!process.env.NEKKO_TEST_SOURCE;
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { before, checks: [], captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('show', () => report.errors.push('Became visible'));
  win.on('focus', () => report.errors.push('Took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const wait = async selector => { for (let i=0; i<80; i++) { if(await run('!!document.querySelector('+JSON.stringify(selector)+')')) return; await sleep(100); } throw Error('Missing '+selector); };
  const click = async selector => { await wait(selector); await run('document.querySelector('+JSON.stringify(selector)+').click()'); await sleep(150); };
  const check = async (name, code) => { const value = await run(code); report.checks.push({name, value}); if(!value) throw Error(name); };
  const shot = async (name, rect) => { await run('document.getAnimations().forEach(a=>{if(a.effect?.getTiming().iterations!==Infinity)try{a.finish()}catch{}})'); await sleep(100); await win.capturePage(rect,{stayHidden:true}); await sleep(100); const file=path.join(out,(before?'before-':'after-')+name+'.png'); fs.writeFileSync(file,(await win.capturePage(rect,{stayHidden:true})).toPNG()); report.captures.push(file); };
  const rect = selector => run('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-4),y:Math.max(0,Math.floor(r.y)-4),width:Math.ceil(r.width)+8,height:Math.ceil(r.height)+8}})()');
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('nekko.commandWall',JSON.stringify({root:{id:'a-pane',kind:'chat',refId:'a'},hero:'a',watermark:1,zonesIntro:true,autoAdd:false,layout:{mode:'focus'},dock:{show:false},agentPanel:{show:true}}));" });
    await win.loadFile(path.join(out,'index.html')); await wait('[data-agent-panel]'); await sleep(700);
    await run(`(()=>{const h=document.documentElement; const off=()=>h.removeAttribute('data-app-inactive');off();new MutationObserver(off).observe(h,{attributes:true,attributeFilter:['data-app-inactive']})})()`);
    await run(`(()=>{const f=layoutFixture,s=f.records[0],t=Date.now()-600000;s.title='Refine permissions and subagents';s.mode='guardrails';s.messages=[{id:'u',role:'user',content:'Refine the interface.',createdAt:t},{id:'r',role:'assistant',content:'Checking the changes with three subagents.',createdAt:t+1000}];for(let n=1;n<=3;n++)f.records.push({...s,id:'k'+n,title:['Inspect the sidebar','Verify permissions menu','Check the documentation'][n-1],parentSessionId:'a'});f.records.forEach(f.putCachedSession);f.opened=null;f.bridge.openPath=async url=>{f.opened=url};f.bridge.setSessionOptions=async(id,patch)=>{const record=f.records.find(s=>s.id===id);Object.assign(record,patch);f.putCachedSession(record);return {...record}}})()`);
    await run('layoutFixture.store.getState().refreshSessions()'); await sleep(800);
    await run("layoutFixture.store.setState({focusRequest:{sessionId:'a'}})");
    await wait('[data-subagent-row="k3"]'); await sleep(500);
    report.geometry = await run(`(()=>{const parent=[...document.querySelectorAll('.agent-chip')].find(e=>e.textContent.includes('Refine permissions'));const icon=parent.querySelector('[title="3 sub-agents spawned by this chat"] svg').getBoundingClientRect();const tree=document.querySelector('[data-subagent-tree]').getBoundingClientRect();return {icon:icon.left+icon.width/2,tree:tree.left}})()`);
    if(!before) await check('Tree line aligns under parent subagent icon', 'Math.abs(('+JSON.stringify(report.geometry.icon)+') - ('+JSON.stringify(report.geometry.tree)+')) <= 1');
    await shot('tree-wide', await rect('[data-agent-panel]'));
    await shot('app-wide');
    // Existing fixture helper mounts the real ChatPane; no duplicate UI markup.
    await run('layoutFixture.showFolderComposer(false, false, "full")'); await wait('[data-asks-first]'); await sleep(800);
    for(const width of [1100,390]) {
      win.setContentSize(width,720); await sleep(350);
      await click('[data-asks-first]'); await shot('permissions-'+width);
      await check('Menu fits viewport '+width, "(()=>{const r=document.querySelector('[data-asks-menu]').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()");
      if(!before) {
        await check('Three named checkmark rows '+width, "document.querySelectorAll('.permission-row').length===3 && [...document.querySelectorAll('[data-asks-toggle]')].every(b=>b.textContent.trim() && b.querySelector('.permission-check') && !b.querySelector('[role=switch]'))");
        await check('Cloud internet locked with enabled info '+width, "document.querySelector('[data-asks-toggle=internet]').disabled && !document.querySelector('[data-asks-info=internet]').disabled");
        const state = await run("JSON.stringify(layoutFixture.records[0])");
        await click('[data-asks-info=shield]');
        await check('Info does not mutate chat '+width, 'JSON.stringify(layoutFixture.records[0]) === '+JSON.stringify(state));
        await check('Shield explains limitations and links docs '+width, "(()=>{const d=document.querySelector('[data-asks-detail=shield]');return /images/.test(d.textContent) && /Claude Agent/.test(d.textContent) && d.querySelector('a').href==='https://nekkoagent.com/docs/privacy-shield'})()");
        await shot('shield-info-'+width);
        await click('[data-asks-detail=shield] a');
        await check('Documentation uses external-link bridge '+width,"layoutFixture.opened==='https://nekkoagent.com/docs/privacy-shield'");
        await click('[data-asks-info=shield]');
        await click('[data-asks-toggle=incognito]'); await click('[data-asks-toggle=shield]');
        await check('Toggles persist to existing chat options '+width,"layoutFixture.records[0].incognito && layoutFixture.records[0].privacy.mode==='redact' && document.querySelector('[data-asks-toggle=shield]').getAttribute('aria-checked')==='true'");
        await shot('permissions-enabled-'+width);
        await click('[data-asks-toggle=incognito]'); await click('[data-asks-toggle=shield]');
        await run("document.querySelector('[data-asks-info=shield]').focus()");
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'}); await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}); await sleep(150);
        await check('Keyboard opens explanation '+width,"!!document.querySelector('[data-asks-detail=shield]')");
        await click('[data-asks-info=shield]');
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}); await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}); await sleep(150);
        await check('Escape restores trigger focus '+width,"!document.querySelector('[data-asks-menu]') && document.activeElement.hasAttribute('data-asks-first')");
      } else await click('[data-asks-first]');
    }
    if(!before) {
      win.setContentSize(1100,720); await sleep(150); await click('[data-asks-first]');
      await run("layoutFixture.store.setState({providers:layoutFixture.store.getState().providers.map(p=>({...p,kind:'ollama'}))})"); await sleep(200);
      await click('[data-asks-toggle=internet]');
      const crop=await rect('[data-asks-menu]'); const frames=[];
      // Deterministic seek of actual CSS animations retains hidden-window safety.
      for(const key of ['incognito','shield','internet']) {
        await run('document.querySelector('+JSON.stringify('[data-asks-toggle='+key+']')+').click()'); await sleep(20);
        const motion = await run('document.querySelector('+JSON.stringify('[data-asks-toggle='+key+'] .permission-glyph')+').getAnimations().map(a=>a.animationName)');
        if(!motion.includes('permission-enable')) throw Error('Enable motion missing '+key);
        await run('document.getAnimations().forEach(a=>{if(a.animationName?.startsWith("permission-"))a.pause()})');
        for(const time of [0,40,80,120,160,220,400,700]) {
          await run('document.getAnimations().forEach(a=>{if(a.animationName?.startsWith("permission-"))a.currentTime='+time+'})');
          await sleep(40); frames.push((await win.capturePage(crop,{stayHidden:true})).toPNG());
        }
        await run('document.getAnimations().forEach(a=>{if(a.animationName?.startsWith("permission-"))a.finish()})');
      }
      const gif=path.join(out,'after-permission-enable.gif');writeGif(gif,frames,8);report.captures.push(gif);
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await check('Reduced motion disables enable animation', "[...document.querySelectorAll('.permission-glyph')].every(e=>getComputedStyle(e).animationName==='none')");
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
      await click('[data-asks-first]');
      await run("layoutFixture.store.setState({providers:layoutFixture.store.getState().providers.map(p=>({...p,kind:'ollama'}))})");await sleep(200);await click('[data-asks-first]');
      await check('Local model may disable internet', "!document.querySelector('[data-asks-toggle=internet]').disabled");
      await click('[data-asks-toggle=internet]');
      await check('Local offline writes existing setting',"layoutFixture.records[0].offline===true && document.querySelector('[data-asks-toggle=internet]').getAttribute('aria-checked')==='false'");
      await click('[data-asks-toggle=internet]');
      await check('Internet enable has its own motion',"getComputedStyle(document.querySelector('[data-asks-toggle=internet] .permission-glyph')).animationName==='permission-enable'");
    }
    if(!before) {
      win.setContentSize(390,420); await sleep(200);
      await click('[data-asks-info=shield]');
      await check('Short menu scrolls inside viewport', "(()=>{const e=document.querySelector('[data-asks-menu]'),r=e.getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight && getComputedStyle(e).overflowY==='auto' && e.scrollHeight>e.clientHeight})()");
      await shot('short-shield-info');
    }
    report.background={visible:win.isVisible(),focused:win.isFocused(),bounds:win.getBounds()};
    if(report.background.visible || report.background.focused) throw Error('Unsafe window state');
  } catch(e) { report.errors.push(String(e.stack||e)); }
  finally { fs.writeFileSync(path.join(out,'quiet-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));win.destroy();app.exit(report.errors.length?1:0); }
});
