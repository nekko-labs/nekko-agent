// Isolated full-App renderer verification. Run through layout-evidence-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const js = value => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', e => { if(e.level==='error') errors.push(e.message); });
  win.webContents.on('render-process-gone', (_e, details) => console.error(details));
  const run = s => win.webContents.executeJavaScript(s, true);
  const checks = [];
  const check = async (name, expression) => { if(!await run(expression)) { console.error(await run(`JSON.stringify({buttons:[...document.querySelectorAll('[data-agent-panel] .agent-panel-plus')].map(b=>({rect:b.getBoundingClientRect().toJSON(),expanded:b.getAttribute('aria-expanded')})),errors:document.body.innerText.slice(0,100)})`)); throw Error(name); } checks.push(name); };
  const shot = async name => {
    // Hidden Electron pauses entrance animations; settle finite entrances for stills only.
    await run(`document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().endTime<2000) a.finish()})`);
    await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    win.webContents.invalidate(); await sleep(200);
    const image = await win.capturePage(undefined, {stayHidden:true});
    fs.writeFileSync(path.join(out,name+'.png'),image.toPNG());

  };
  const hover = async selector => { const r = await run(`(()=>{const r=document.querySelector(${js(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(r.x),y:Math.round(r.y)}); await sleep(450); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(1600);
    for (const width of [1200,400]) {
      win.setContentSize(width,900); await sleep(300);
      if(width===400) { await run(`document.querySelector('[aria-label="Open agent list"]')?.click()`); await sleep(600); }
      await shot('toolbar-'+width);
      if(width===400) {
        if(await run(`!!document.querySelector('[data-wall-create-toggle]')`)) {
          await hover('[data-wall-create-toggle]'); await shot('header-menu-400');
          await check('header menu fits narrow viewport', `(()=>{const r=document.querySelector('[data-wall-create-menu]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`);
          win.webContents.sendInputEvent({type:'mouseMove',x:390,y:850}); await sleep(350);
        }
        continue;
      }
      win.webContents.sendInputEvent({type:'mouseMove',x:390,y:850}); await sleep(350);
      await hover('[data-agent-panel] .agent-panel-plus');
      await check('sidebar hover opens at '+width, `!!document.querySelector('[data-new-agent-menu]')`);
      await shot('sidebar-menu-'+width);
      await hover('[data-new-agent-menu] button:last-child'); await shot('sidebar-active-'+width);
      await check('sidebar stays inside viewport at '+width, `(()=>{const r=document.querySelector('[data-new-agent-menu]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`);
      win.webContents.sendInputEvent({type:'mouseMove',x:380,y:750}); await sleep(400);
    }
    win.setContentSize(1200,900); await sleep(300);
    if(await run(`!!document.querySelector('[data-wall-create-toggle]')`)) {
      await hover('[data-wall-create-toggle]'); await shot('header-menu');
      await check('header has three choices with hints', `document.querySelectorAll('[data-wall-create-menu] button').length===3&&document.querySelectorAll('[data-wall-create-menu] kbd').length===3`);
      await hover('[data-wall-create-menu] button:last-child'); await shot('header-active');
      win.webContents.sendInputEvent({type:'mouseMove',x:600,y:750}); await sleep(400);
      if(await run(`!!document.querySelector('[data-wall-create-menu]')`)) throw Error('Header menu did not close');
    }
    await hover('[data-chat-finder-toggle]'); await shot('search-hover');
    await run(`document.querySelector('[data-chat-finder-toggle]').click()`); await sleep(400); await shot('search-open');
    await check('search click opens popup', `!!document.querySelector('[data-chat-finder]')`);
    if (process.env.NEKKO_TEST_REVISION) {
      await run(`document.querySelector('[data-chat-finder-toggle]').click();document.documentElement.dataset.theme='light'`); await sleep(200);
      await hover('[data-agent-panel] .agent-panel-plus'); await shot('light-menu');
      await hover('[data-new-agent-menu] button:last-child'); await shot('light-active');
    }
    if(!process.env.NEKKO_TEST_REVISION) {
      await check('search focuses input', `document.activeElement===document.querySelector('[data-chat-finder] input')`);
      await check('search displays shortcut', `document.querySelector('[data-chat-finder] kbd').textContent.includes('Shift')`);
      await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',metaKey:true,shiftKey:true,bubbles:true}))`); await sleep(200);
      await check('search shortcut closes popup', `!document.querySelector('[data-chat-finder]')`);
      await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',metaKey:true,shiftKey:true,bubbles:true}))`); await sleep(200);
      await check('search shortcut opens popup', `!!document.querySelector('[data-chat-finder]')`);
      await run(`document.documentElement.dataset.theme='light'; document.querySelector('[data-chat-finder-toggle]').click()`); await sleep(200);
      await hover('[data-agent-panel] .agent-panel-plus'); await shot('light-menu');
      await hover('[data-new-agent-menu] button:last-child'); await shot('light-active');
      await run(`document.documentElement.dataset.theme='dark'`); await sleep(400); win.webContents.invalidate(); await sleep(200);
      const motion=path.join(out,'motion'); fs.mkdirSync(motion,{recursive:true});
      for(let i=0;i<20;i++) {
        if(i===1) await hover('[data-wall-create-toggle]');
        if(i===8) await hover('[data-wall-create-menu] button:last-child');
        if(i===13) win.webContents.sendInputEvent({type:'mouseMove',x:600,y:750});
        fs.writeFileSync(path.join(motion,`frame-${String(i).padStart(2,'0')}.png`),(await win.capturePage(undefined,{stayHidden:true})).toPNG()); await sleep(100);
      }
      await run(`document.querySelector('[data-wall-create-toggle]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`); await sleep(200);
      await check('keyboard opening focuses first choice', `document.activeElement===document.querySelector('[data-wall-create-menu] button')`);
      await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await sleep(100);
      await check('Escape restores opener', `!document.querySelector('[data-wall-create-menu]')&&document.activeElement===document.querySelector('[data-wall-create-toggle]')`);
      await run(`document.querySelector('[aria-label="Hide the agent panel"]').click()`); await sleep(500);
      await run(`document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().endTime<2000)a.finish()})`); await sleep(100);
      await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',metaKey:true,shiftKey:true,bubbles:true}))`); await sleep(500);
      await check('search shortcut reveals closed panel', `!!document.querySelector('[data-chat-finder]')&&!document.querySelector('[data-panel-open="false"]')`);
      await run(`layoutFixture.store.setState({view:'skills'});`); await sleep(200);
      await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',metaKey:true,shiftKey:true,bubbles:true}))`); await sleep(500);
      await check('search shortcut opens from another view', `layoutFixture.store.getState().view==='command'&&!!document.querySelector('[data-chat-finder]')`);
      await run(`(()=>{const f=layoutFixture;window.mediaCalls=[];f.bridge.createSession=async()=>({...f.records[0],id:'media-shortcut',messages:[]});f.bridge.setSessionOptions=async(id,options)=>{mediaCalls.push(options);return {...f.records[0],id,...options,messages:[]}};f.store.setState({chatFinderOpen:false});})()`);
      await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'I',metaKey:true,shiftKey:true,bubbles:true}))`); await sleep(400);
      await check('media shortcut creates an image chat', `mediaCalls.length===1&&mediaCalls[0].chatType==='image'&&!('modelId' in mediaCalls[0].imageParams)`);

    }
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({checks,errors,hidden:!win.isVisible(),bounds:win.getBounds()},null,2));
  } catch(e) { console.error(e); process.exitCode=1; }
  finally { win.destroy(); app.quit(); }
});
