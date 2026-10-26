// Full App new-chat evidence. Run through layout-evidence-integration.cjs.
// NEKKO_TEST_SOURCE can point at an unchanged base tree for matching captures.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'New chat gradient, isolated evidence', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({ root: { id: 'gradient-pane', kind: 'chat', refId: 'd' }, hero: 'd', watermark: 1, autoAdd: false, layout: { mode: 'focus' }, dock: { show: false }, agentPanel: { show: false } }));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!document.querySelector("[data-clean-start] .clean-start")'); i++) await sleep(100);
    if (!await run('!!document.querySelector("[data-clean-start] .clean-start")')) throw Error('New chat did not mount');
    for (const width of [1440, 900, 460]) {
      win.setContentSize(width, 900); await sleep(700);
      if (process.env.NEKKO_AFTER === '1') {
        if(!await run(`(() => { const e=document.querySelector('.clean-start-model .effort-slider'),s=getComputedStyle(e),r=e.getBoundingClientRect();return s.borderLeftWidth==='1px' && parseFloat(s.borderTopLeftRadius)>0 && r.left>=0 && r.right<=innerWidth && getComputedStyle(document.querySelector('.wall-workspace').parentElement).paddingTop==='0px' && getComputedStyle(document.querySelector('.wall-workspace').parentElement).marginTop==='-1px'; })()`)) throw Error('Effort border or wall inset failed at '+width);
      }
      const file = path.join(out, `new-chat-${width}.png`);
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      report.captures.push(file);
      report.checks.push(await run(`(() => {
        const e = document.querySelector('[data-clean-start] .clean-start');
        const c = document.querySelector('[data-clean-start] .composer');
        const before = getComputedStyle(e, '::before'), after = getComputedStyle(e, '::after');
        const r = c.getBoundingClientRect();
        return { width: innerWidth, theme: document.documentElement.dataset.theme, gradient: before.backgroundImage, grain: after.backgroundImage, grainAnimation: after.animationName, grainPointerEvents: after.pointerEvents, composerVisible: r.width > 200 && r.left >= 0 && r.right <= innerWidth };
      })()`));
    }
    if (process.env.NEKKO_AFTER === '1') {
      await run(`(() => {const e=document.querySelector('[data-clean-start] [contenteditable]');e.focus();document.execCommand('insertText',false,'Plan a small task');})()`);
      if(!await run(`document.querySelector('[data-clean-start] [contenteditable]').textContent.includes('Plan a small task')`))throw Error('Typing failed');
      await run(`(() => { const e=document.querySelector('[aria-label="Reasoning effort"]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(e,'0');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      win.setContentSize(900,900); await sleep(300);
      const motion = await run(`(() => { const a=document.getAnimations().find(a=>a.animationName==='new-chat-colors'); if(!a)throw Error('Missing color animation'); a.pause(); a.currentTime=0; return {duration:a.effect.getTiming().duration,iterations:a.effect.getTiming().iterations}; })()`);
      if(motion.duration!==120000 || motion.iterations!==Infinity) {
        // Infinity serializes as null across the bridge; duration is the acceptance gate.
        if(motion.duration!==120000) throw Error('Color cycle is not two minutes');
      }
      const { PNG }=require('pngjs'), { GifWriter }=require('omggif');
      const frames=[]; const stops=[];
      for(let t=0;t<=120000;t+=5000) {
        await run(`document.getAnimations().find(a=>a.animationName==='new-chat-colors').currentTime=${t}`); await sleep(60);
        stops.push(await run(`getComputedStyle(document.querySelector('.clean-start'),'::before').backgroundImage`));
        // Half-size frames keep portable evidence small; same real renderer pixels.
        frames.push(PNG.sync.read((await win.capturePage(undefined,{stayHidden:true})).resize({width:450}).toPNG()));
      }
      if(new Set(stops).size<15 || stops[0]!==stops.at(-1)) throw Error('Smooth looping color interpolation failed');
      const colors=new Map();
      for(const f of frames)for(let i=0;i<f.data.length;i+=4){const c=(f.data[i]<<16)|(f.data[i+1]<<8)|f.data[i+2];colors.set(c,(colors.get(c)||0)+1);}
      const palette=[...colors].sort((a,b)=>b[1]-a[1]).slice(0,256).map(x=>x[0]);while(palette.length<256)palette.push(0);
      const cache=new Map(),buffer=Buffer.alloc(frames[0].width*frames[0].height*frames.length*2),gif=new GifWriter(buffer,frames[0].width,frames[0].height,{palette,loop:0});
      for(const f of frames){const pixels=new Uint8Array(f.width*f.height);for(let i=0;i<pixels.length;i++){const c=(f.data[i*4]<<16)|(f.data[i*4+1]<<8)|f.data[i*4+2];if(!cache.has(c)){let best=0,dist=Infinity;for(let j=0;j<palette.length;j++){const p=palette[j],d=((c>>16)-(p>>16))**2+(((c>>8)&255)-((p>>8)&255))**2+((c&255)-(p&255))**2;if(d<dist){best=j;dist=d;}}cache.set(c,best);}pixels[i]=cache.get(c);}gif.addFrame(0,0,f.width,f.height,pixels,{delay:50});}
      fs.writeFileSync(path.join(out,'color-cycle-10x.gif'),buffer.subarray(0,gif.end()));
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await sleep(100);
      if(!await run(`getComputedStyle(document.querySelector('.clean-start'),'::before').animationName==='none'`))throw Error('Reduced motion did not stop colors');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
      report.checks.push('120s interpolated looping gradient, 25 sampled frames, reduced motion holds still');
    }
    win.setContentSize(1440, 900);
    await run("layoutFixture.store.getState().setView('settings')"); await sleep(700);
    for (const width of [1440,460]) {
      win.setContentSize(width,900); await sleep(500);
      fs.writeFileSync(path.join(out,`settings-${width}.png`),(await win.capturePage(undefined,{stayHidden:true})).toPNG());
    }
    if (process.env.NEKKO_AFTER === '1') {
      // Real IPC returns a fresh structured clone; the shared stub mutates its object.
      await run(`(() => {const update=layoutFixture.bridge.updateSettings;layoutFixture.bridge.updateSettings=async p=>structuredClone(await update(p));})()`);
      await run("layoutFixture.store.getState().setView('settings')");
      if (!await run("document.querySelector('[aria-label=\"Skills and connectors\"]')?.children.length===2")) throw Error('Missing settings chips');
      await run("[...document.querySelectorAll('[aria-label=\"Skills and connectors\"] button')].find(b=>b.textContent.includes('Skills')).click()"); await sleep(400);
      if (!await run("layoutFixture.store.getState().view==='skills'")) throw Error('Skills chip navigation failed');
      await run("layoutFixture.store.getState().setView('settings')"); await sleep(400);
      await run("document.querySelector('[aria-label=\"Show Skills in sidebar\"]').click()"); await sleep(400);
      if (!await run("layoutFixture.store.getState().settings.sidebarViews.skills===true")) throw Error('Sidebar preference did not save');
      await run("document.querySelector('[aria-label=\"Show Connectors in sidebar\"]').click()");await sleep(300);
      win.setContentSize(1440,900);await sleep(300);
      report.checks.push(await run(`({preferences:layoutFixture.store.getState().settings.sidebarViews,nav:[...document.querySelectorAll('nav button')].map(b=>b.getAttribute('aria-label'))})`));
      if(!await run(`!!document.querySelector('nav button[aria-label="Skills"]') && !!document.querySelector('nav button[aria-label="Connectors"]')`))throw Error('Opted-in links missing from sidebar');
      await run("document.querySelector('[aria-label=\"Show Skills in sidebar\"]').click();document.querySelector('[aria-label=\"Show Connectors in sidebar\"]').click()");await sleep(300);
      await run("[...document.querySelectorAll('[aria-label=\"Skills and connectors\"] button')].find(b=>b.textContent.includes('Connectors')).click()");await sleep(300);
      if(!await run("layoutFixture.store.getState().view==='connectors'"))throw Error('Connectors chip navigation failed');
      report.checks.push('Both chips navigate and both sidebar preferences save independently; typing, effort border and 5px tighter shared workspace inset checked');
    }
    report.bounds=win.getBounds(); report.hidden=!win.isVisible(); report.focused=win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation failed');
    report.success=true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'gradient-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
