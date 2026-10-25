// Hidden renderer-only evidence. Launch through layout-evidence-integration.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'focus-monitor-profile'));
const js = value => JSON.stringify(value).replace(/</g, '\\u003c');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { source: process.env.NEKKO_TEST_SOURCE || 'worktree', captures: [], assertions: [], metrics: {}, errors: [], interaction: 'DOM DragEvent with shared DataTransfer, not OS input or native drag' };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const displays = screen.getAllDisplays();
  const win = new BrowserWindow({ width: 1100, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...displays.map(d => d.bounds.x)) - 1800, y: Math.min(...displays.map(d => d.bounds.y)) - 1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = (name, pass, details) => report.assertions.push({ name, pass: !!pass, details });
  win.on('focus', () => report.errors.push('Window received focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const capture = async (name, rect) => {
    check(`${name}: hidden`, !win.isVisible() && !win.isFocused(), win.getBounds());
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG());
    report.captures.push(file);
    return file;
  };
  const dock = async side => {
    await run(`(()=>{const b=document.querySelector('[aria-label="Configure monitors"]');if(b.getAttribute('aria-expanded')!=='true')b.click()})()`);
    await wait(100);
    await run(`(()=>{const b=[...document.querySelectorAll('.monitors-dock__positions button')].find(b=>b.textContent.toLowerCase()===${js(side)});if(!b)throw Error('Missing position');b.click()})()`);
    await wait(100);
    await run(`(()=>{const b=document.querySelector('[aria-label="Configure monitors"]');if(b.getAttribute('aria-expanded')==='true')b.click()})()`);
    await wait(500);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-command-wall]")'); i++) await wait(100);
    await wait(700);
    for (const side of ['left', 'right']) {
      win.setContentSize(720, 800);
      await dock(side);
      await run(`document.querySelector('[aria-label="Configure monitors"]').click()`);
      await wait(300);
      const bounds = await run(`(()=>{const e=document.querySelector('.monitors-dock__popover');const b=e.getBoundingClientRect();const controls=[...e.querySelectorAll('button,input')];return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height,viewport:[innerWidth,innerHeight],controls:controls.length,reachable:controls.every(c=>{const r=c.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})}})()`);
      report.metrics[`${side}Menu`] = bounds;
      check(`${side} menu fits viewport`, bounds.x >= 0 && bounds.right <= 720 && bounds.y >= 0 && bounds.bottom <= 800, bounds);
      check(`${side} menu controls hit-test`, bounds.reachable && bounds.controls > 5, bounds);
      await capture(`configure-${side}-720x800`);
      await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await wait(60);
      check(`${side} Escape closes menu`, !await run(`!!document.querySelector('.monitors-dock__popover')`));
      await run(`document.querySelector('[aria-label="Configure monitors"]').click()`);
      await run(`document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
      await wait(60);
      check(`${side} outside click closes menu`, !await run(`!!document.querySelector('.monitors-dock__popover')`));
    }
    win.setContentSize(1440, 900);
    await dock('right');
    await run(`document.querySelector('[aria-label="Show agents in a row"]').click()`);
    await wait(500);
    report.metrics.horizontal = await run(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};return {wall:[...document.querySelectorAll('[data-command-wall]')].map(rect),panels:[...document.querySelectorAll('[data-agent-panel]')].map(rect),dock:rect(document.querySelector('.monitors-dock')),layout:layoutFixture.store.getState().settings.commandWall}})()`);
    check('horizontal agent row has bounded height', report.metrics.horizontal.panels.some(p => p.w > 700 && p.h < 400), report.metrics.horizontal);
    report.metrics.rowGap = await run(`(()=>{const list=document.querySelector('.agent-panel-row');const cards=[...list.querySelectorAll('.collapse-wrap > div > *')];const bottom=Math.max(...cards.map(e=>e.getBoundingClientRect().bottom));const r=list.getBoundingClientRect();return {cardCount:cards.length,cardBottom:bottom,scrollbarTop:r.top+list.clientHeight,gap:r.top+list.clientHeight-bottom,panelBottom:list.closest('[data-agent-panel]').getBoundingClientRect().bottom,listBottom:r.bottom}})()`);
    check('cards meet scrollbar without empty row space', report.metrics.rowGap.cardCount > 0 && Math.abs(report.metrics.rowGap.gap) <= 4, report.metrics.rowGap);
    check('no space after row scrollbar', Math.abs(report.metrics.rowGap.panelBottom-report.metrics.rowGap.listBottom)<=1, report.metrics.rowGap);
    await capture('horizontal-agents-1440x900');
    win.setContentSize(1100, 800);
    await dock('right');
    const before = await run(`[...document.querySelectorAll('.monitors-dock__monitor')].map(e=>e.dataset.monitor)`);
    check('multiple monitors available', before.length > 1, before);
    await capture('reorder-before');
    await run(`(()=>{window.dragTransfer=new DataTransfer();const h=document.querySelector('.monitors-dock__monitor-header');const r=h.getBoundingClientRect();window.dragStart={x:r.x+35,y:r.y+12};h.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dragTransfer,clientX:dragStart.x,clientY:dragStart.y}))})()`);
    const frames = [];
    const geometry = () => run(`(()=>{const l=document.querySelector('.monitors-dock__monitors');const r=l.getBoundingClientRect();return {x:r.x,width:r.width,clientWidth:l.clientWidth,scrollTop:l.scrollTop,height:r.height}})()`);
    const liftedGeometry = await geometry();
    for (let i=0;i<20;i++) {
      if (i===4 || i===7) await run(`(()=>{const list=document.querySelector('.monitors-dock__monitors');const targets=[...list.querySelectorAll('[data-monitor]:not([data-monitor-lifted])')];const r=targets[Math.min(1,targets.length-1)].getBoundingClientRect();window.dragEnd={x:r.x+50,y:r.bottom-4};list.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dragTransfer,clientX:dragEnd.x,clientY:dragEnd.y}))})()`);
      if (i===10) await run(`document.querySelector('.monitors-dock__monitors').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dragTransfer,clientX:dragEnd.x,clientY:dragEnd.y}))`);
      if (i===3 || i===9 || i===19) {
        const g=await geometry();
        check(`reorder frame ${i} keeps scroll surface stable`, Math.abs(g.x-liftedGeometry.x)<1 && g.clientWidth===liftedGeometry.clientWidth && g.scrollTop===liftedGeometry.scrollTop, {before:liftedGeometry,after:g});
      }
      frames.push(await capture(`reorder-${String(i).padStart(2,'0')}`, { x: 700, y: 0, width: 400, height: 800 }));
      await wait(55);
    }
    await wait(400);
    const after = await run(`[...document.querySelectorAll('.monitors-dock__monitor')].map(e=>e.dataset.monitor)`);
    check('DOM drag changes monitor order', before.join() !== after.join(), { before, after });
    await capture('reorder-after');
    try {
      const modules = process.env.NEKKO_TEST_MODULES;
      const { PNG } = require(path.join(modules, 'pngjs'));
      const { GifWriter } = require(path.join(modules, 'omggif'));
      const images = frames.map(f=>PNG.sync.read(fs.readFileSync(f)));
      const { width, height } = images[0];
      if (images.some(im => im.width !== width || im.height !== height)) throw new Error('GIF frame dimensions must match');
      const counts = new Map();
      for (const im of images) for(let i=0;i<im.data.length;i+=4) { const c=(im.data[i]<<16)|(im.data[i+1]<<8)|im.data[i+2];counts.set(c,(counts.get(c)||0)+1); }
      const palette=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,256).map(p=>p[0]);while(palette.length<256)palette.push(0);
      const cache=new Map();const nearest=c=>{if(cache.has(c))return cache.get(c);let best=0,dist=Infinity;palette.forEach((p,j)=>{const d=((c>>16)-(p>>16))**2+(((c>>8)&255)-((p>>8)&255))**2+((c&255)-(p&255))**2;if(d<dist){dist=d;best=j}});cache.set(c,best);return best};
      const buffer=Buffer.alloc(images.length*width*height*2+4096);const gif=new GifWriter(buffer,width,height,{loop:0,palette});
      for(const im of images){const pixels=Buffer.alloc(width*height);for(let i=0;i<pixels.length;i++)pixels[i]=nearest((im.data[i*4]<<16)|(im.data[i*4+1]<<8)|im.data[i*4+2]);gif.addFrame(0,0,width,height,pixels,{delay:8});}
      fs.writeFileSync(path.join(out,'reorder.gif'),buffer.subarray(0,gif.end()));
      report.gif=path.join(out,'reorder.gif');
    } catch(e) {report.errors.push(`GIF: ${e.stack}`);}
  } catch(e) { report.errors.push(String(e.stack || e)); }
  report.window={bounds:win.getBounds(),visible:win.isVisible(),focused:win.isFocused(),profile:app.getPath('userData')};
  fs.writeFileSync(path.join(out,'focus-monitor-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  app.exit(report.captures.length ? 0 : 1);
});
