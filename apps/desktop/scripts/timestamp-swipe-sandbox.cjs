// Synthetic timestamp drag, clipping and release-motion evidence;
// never connects to the user's host or profile. Launched through
// chat-search-integration.cjs with NEKKO_SANDBOX=chat-timing-sandbox.cjs
// (NEKKO_TEST_REVISION=<rev> for "before"). Hidden, non-focusable, off-screen;
// renderer input only (sendInputEvent), no OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-search-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'timing-before' : 'timing-after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  // macOS moves a shown off-screen window back onto a display, so it is never shown.
  const win = new BrowserWindow({
    width: 1100, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic chat timing verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], measures: {} };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  const capture = async name => fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  try {
    await win.loadFile(path.join(out, 'index.html'), { hash: 'timestamp-swipe' });
    await sleep(1500);
    await run('integration.reset()'); await sleep(1500);
    // Renderer input only. Hold a real primary-button drag still past both
    // wheel idle deadlines, then capture its release animation.
    for (const width of [1100, 430]) {
      win.setContentSize(width, 760); await sleep(600);
      await run('integration.reset()'); await sleep(1200);
    // Open the last run of working steps (an activity header, not a row inside one) so its rows show.
    const target = await run(`(()=>{
      const groups=[...document.querySelectorAll('[data-transcript-scroll] button[aria-expanded="false"]')].filter(b=>b.closest('.font-mono')&&!b.closest('li'));
      const g=groups[groups.length-1]; if(!g) return null; g.scrollIntoView({block:'center'});
      const r=g.getBoundingClientRect(); return {x:Math.round(r.left+20),y:Math.round(r.top+r.height/2)};
    })()`);
    if (target) for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await sleep(400);
    await run(`document.querySelector('[data-purpose-group] > button')?.click()`); await sleep(300);
    const elapsed = await run(`[...document.querySelectorAll('[data-tool-elapsed]')].map(e=>e.textContent)`);
    report.measures.elapsed = elapsed;
    if (!base) check('nested tool rows retain their elapsed times', elapsed.length === 3 && elapsed.join(',') === '3.0s,1.0s,1.0s');
    await capture('tool-elapsed');


      const origin = await run(`(()=>{const s=document.querySelector('[data-transcript-scroll]');const r=s.getBoundingClientRect();const tool=s.querySelector('[data-tool-elapsed]').getBoundingClientRect();return {x:Math.round(r.right-24),y:Math.round(tool.bottom+28)}})()`);
      win.webContents.sendInputEvent({type:'mouseMove',...origin});
      win.webContents.sendInputEvent({type:'mouseDown',...origin,button:'left',clickCount:1});
      win.webContents.sendInputEvent({type:'mouseMove',x:origin.x-112,y:origin.y,button:'left'});
      await sleep(900);
      const state = await run(`(()=>{const s=document.querySelector('[data-transcript-scroll]');return {reveal:s.style.getPropertyValue('--vt-reveal'),swiping:s.classList.contains('vt-swiping'),scrollLeft:s.scrollLeft}})()`);
      report.measures['held-'+width] = state;
      if (!base) check('stationary drag stays revealed at '+width, state.reveal==='112px' && state.swiping);
      await capture('held-'+width);
      if (!base) check('no horizontal scroll at '+width, state.scrollLeft===0);
      // Measure the actual pseudo-element text, not just its opacity.
      const bounds = await run(`(()=>{const s=document.querySelector('[data-transcript-scroll]');const clip=s.getBoundingClientRect();return [...s.querySelectorAll('li[data-vt-stamp]')].map(e=>{const r=e.getBoundingClientRect(),p=getComputedStyle(e,'::after');const c=document.createElement('canvas').getContext('2d');c.font=p.font;const right=r.right+parseFloat(p.paddingLeft)+c.measureText(e.dataset.vtStamp).width;return {stamp:e.dataset.vtStamp,right,clip:clip.right,visible:Number(p.opacity)===1,fits:right<=clip.right-4}})})()`);
      report.measures['tool-bounds-'+width]=bounds;
      if (!base) check('full tool timestamps fit at '+width,bounds.length>0&&bounds.every(b=>b.visible&&b.fits));
      const frames=[];
      const frame=async()=>frames.push((await win.capturePage(undefined,{stayHidden:true})).toPNG());
      if (!base && width===1100) { await frame(); await sleep(160); await frame(); }
      win.webContents.sendInputEvent({type:'mouseUp',x:origin.x-112,y:origin.y,button:'left',clickCount:1});
      if (!base && width===1100) for(let i=0;i<9;i++){await frame();await sleep(40);}
      await sleep(600);
      if (!base) check('release settles at '+width, await run(`!document.querySelector('[data-transcript-scroll]').classList.contains('vt-swiping') && !document.querySelector('.vt-list').style.transform`));
      await capture('released-'+width);
      if(frames.length) {
        const {PNG}=require('pngjs');const {GifWriter}=require('omggif');
        const images=frames.map(b=>PNG.sync.read(b));const colors=new Map();
        for(const img of images)for(let i=0;i<img.data.length;i+=4){const c=(img.data[i]<<16)|(img.data[i+1]<<8)|img.data[i+2];colors.set(c,(colors.get(c)||0)+1);}
        const palette=[...colors].sort((a,b)=>b[1]-a[1]).slice(0,256).map(c=>c[0]);while(palette.length<256)palette.push(0);
        const nearest=new Map();const indexed=images.map(img=>{const pixels=new Uint8Array(img.width*img.height);for(let i=0;i<pixels.length;i++){const k=i*4,c=(img.data[k]<<16)|(img.data[k+1]<<8)|img.data[k+2];let n=nearest.get(c);if(n===undefined){let best=Infinity;n=0;for(let j=0;j<palette.length;j++){const p=palette[j],d=((c>>16)-(p>>16))**2+(((c>>8)&255)-((p>>8)&255))**2+((c&255)-(p&255))**2;if(d<best){best=d;n=j;}}nearest.set(c,n);}pixels[i]=n;}return pixels;});
        const buf=Buffer.alloc(images[0].width*images[0].height*frames.length*2);const gif=new GifWriter(buf,images[0].width,images[0].height,{loop:0,palette});indexed.forEach((pixels,i)=>gif.addFrame(0,0,images[0].width,images[0].height,pixels,{delay:i<2?30:5}));fs.writeFileSync(path.join(dir,'drag-release.gif'),buf.subarray(0,gif.end()));
      }
    }
    report.success = !report.errors.some(e => /focus/.test(e)) && (base || report.checks.every(c => c.passed));
  } catch (error) {
    report.errors.push(String(error && error.stack || error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, checks: report.checks, errors: [...new Set(report.errors)].slice(0, 6), measures: report.measures }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
