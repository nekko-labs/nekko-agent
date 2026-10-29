// Synthetic full App; hidden, isolated profile, no network, OS input or real host.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const before = process.env.NEKKO_BEFORE === '1';
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'New chat laugh isolated verification', width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], captures: [], errors: [] };
  win.on('show', () => report.errors.push('Window shown'));
  win.on('focus', () => report.errors.push('Window focused'));
  const run = code => win.webContents.executeJavaScript(code, true).catch(e=>{ throw Error(code+'\n'+String(e)); });
  const check = async (code, label) => { if (!await run(code)) throw Error(label); report.checks.push(label); };
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await win.webContents.insertCSS('.clean-start-greeting.fade-in { animation: none; opacity: 1; } .chat-gradient-drift { animation: none !important; }');
    for (let i=0; i<60 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await run(`(() => { const interval=window.setInterval; window.setInterval=(fn,ms,...args)=>interval(fn,ms===8000?86400000:ms,...args); const f=layoutFixture, s=f.records.find(s=>s.id==='d'); s.mode='guardrails'; s.modelId='claude-opus-5-5'; f.bridge.listModels=async()=>[{id:s.modelId,providerId:'fixture',name:'Opus 5.5',contextWindow:200000}]; f.putCachedSession(s); f.bridge.setSessionOptions=async(id,p)=>{ const s=f.records.find(s=>s.id===id);Object.assign(s,p);return {...s}; }; return f.showGreeting(); })()`);
    await sleep(900);
    for (const width of [1280,460]) {
      win.setContentSize(width,900); await sleep(350);
      await shot('desktop-idle-' + width);
      if (width === 1280) {
      await run(`document.querySelector('[data-chat-mode-button]').click()`); await sleep(250);
      await shot('desktop-mode-'+width);
      await run(`document.querySelector('.mode-scroll').scrollTop=9999`); await sleep(150);
      await shot('desktop-mode-effort-'+width);
      await run(`document.querySelector('.mode-scroll').scrollTop=0`);
      if (!before) {
        await run(`document.querySelector('[data-mode-panel] [data-chat-mode="ask"]').click()`); await sleep(200);
        await check(`layoutFixture.store.getState().settings.defaultChatMode==='ask'`, 'Tool policy remembered on this computer at '+width);
        await check(`document.querySelector('[data-mode-panel]').textContent.includes('Guardrails is recommended for general use')`, 'Guardrails recommendation independent of saved Ask at '+width);
        await run(`document.querySelector('[data-mode-panel] [data-chat-mode="guardrails"]').click()`); await sleep(150);
      }
      await run(`document.querySelector('[data-chat-mode-button]').click()`); await sleep(150);
      }
      await run(`document.querySelector('.effort-slider button').click()`); await sleep(300);
      await shot('desktop-effort-' + width);
      if (!before) {
        await check(`!document.querySelector('[data-effort-popover]').textContent.includes('Default')`, 'Concrete effort values at '+width);
        await check(`document.querySelector('[data-effort-popover] [title="Recommended"]').dataset.effort==='medium'`, 'Medium recommendation independent of selection at '+width);
        await run(`document.querySelector('[data-effort-popover] [data-effort="low"]').click()`); await sleep(250);
        await check(`layoutFixture.store.getState().settings.effort==='low'`, 'Effort choice remembered by this computer at '+width);
        await check(`document.querySelector('[data-effort-popover] [title="Recommended"]').getAttribute('aria-checked')==='false'`, 'Recommendation does not follow saved Low at '+width);
      }
      await run(`document.querySelector('.effort-slider button').click()`); await sleep(100);
      if (!before) {
        const frames=[], started=Date.now();
        await run(`document.querySelector('.greeting-nekko-button').click()`);
        for (let i=0;i<16;i++) { await sleep(85); frames.push((await win.capturePage(undefined,{stayHidden:true})).resize({width:640}).toPNG()); if (i===2) await shot('desktop-laugh-'+width); }
        require('./evidence-gif.cjs')(path.join(out,'desktop-laugh-'+width+'.gif'),frames,Math.max(1,Math.round((Date.now()-started)/frames.length/10)));
        await check(`!document.querySelector('[data-nekko-laugh]')`, 'Laugh returns to caret gaze at '+width);
        // Renderer mouse event tests the real hit target rather than DOM click alone.
        const box=await run(`(()=>{const r=document.querySelector('.greeting-nekko-button').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
        win.webContents.sendInputEvent({type:'mouseDown',...box,button:'left',clickCount:1});
        win.webContents.sendInputEvent({type:'mouseUp',...box,button:'left',clickCount:1}); await sleep(600);
        await check(`!!document.querySelector('[data-nekko-laugh]')`, 'Pointer activates laugh at '+width);
        await run(`document.querySelector('.greeting-nekko-button').click()`); await sleep(700);
        await check(`!!document.querySelector('[data-nekko-laugh]')`, 'Repeated tap restarts laugh timer at '+width);
        await sleep(600);
        await run(`document.querySelector('.effort-slider button').click()`); await sleep(100);
        await run(`document.querySelector('[data-effort-popover] [data-effort="medium"]').click()`); await sleep(150);
        await run(`document.querySelector('.effort-slider button').click()`);
      }
    }
    if (!before) {
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await run(`document.querySelector('.greeting-nekko-button').click()`); await sleep(150);
      await check(`getComputedStyle(document.querySelector('.greeting-nekko')).animationName==='none' && !!document.querySelector('[data-nekko-laugh]')`, 'Reduced motion shows expression without bounce');
      await shot('desktop-reduced-motion'); await sleep(1250);
      win.webContents.debugger.detach();
    }
    // Verify typing and caret gaze still work after the laugh's SVG remount.
    await run(`(()=>{const e=document.querySelector('.composer [contenteditable]');e.focus();e.textContent='A friendly new project';e.dispatchEvent(new Event('input',{bubbles:true}));e.setSelectionRange(0,0);})()`); await sleep(250);
    await check(`document.querySelector('.composer [contenteditable]').value==='A friendly new project'`, 'Composer still accepts text');
    if (!before) await check(`!!document.querySelector('[data-nekko-look]')`, 'Caret gaze restored');
    report.background={visible:win.isVisible(),focused:win.isFocused(),bounds:win.getBounds()};
    if(win.isVisible()||win.isFocused()) throw Error('Isolation failed');
  } catch(e) { report.errors.push(String(e.stack||e)); }
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
  win.destroy();app.exit(report.errors.length?1:0);
});
