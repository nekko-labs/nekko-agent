const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Stars and drag isolated evidence', width: 1000, height: 720, show: false, focusable: false, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const report = {};
  const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(1200);
    await shot('idle');
    let recording = true;
    const frames = [];
    const record = (async () => { while (recording) { frames.push((await win.capturePage(undefined, { stayHidden: true })).toPNG()); await sleep(70); } })();
    report.starRows = await run(`Array.from(document.querySelectorAll('[role="option"]')).filter(e => e.textContent.includes('Starred model')).length`);
    await run(`window.header = document.querySelector('.monitors-dock__monitor-header'); window.box = header.getBoundingClientRect(); header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: box.x+40, clientY: box.y+15 }));`);
    await sleep(250); await shot('pressed');
    report.clickLift = await run(`!!document.querySelector('[data-dock-dragging]')`);
    await run(`header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: box.x+40, clientY: box.y+15 }));`);
    // Native dragstart can carry the original press coordinates. A fresh
    // pointermove is the explicit activation signal, not dragstart coordinates.
    await run(`header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: box.x+40, clientY: box.y+15 })); window.dt = new DataTransfer(); header.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.x+40, clientY: box.y+15 }));`);
    await sleep(100);
    report.stationaryDragLift = await run(`!!document.querySelector('[data-dock-dragging]')`);
    await run(`header.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));`); await sleep(300);
    await run(`header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: box.x+40, clientY: box.y+15 })); header.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, pointerId: 1, clientX: box.x+45, clientY: box.y+20 })); header.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.x+40, clientY: box.y+15 }));`);
    await sleep(100); await shot('dragging');
    report.movedDragLift = await run(`!!document.querySelector('[data-dock-dragging]')`);
    await run(`header.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));`); await sleep(350);
    report.cancelled = await run(`!document.querySelector('[data-dock-dragging]')`);
    await run(`Array.from(document.querySelectorAll('[role="option"]')).filter(e => e.textContent.includes('Starred model')).at(-1).click()`);
    report.selected = await run('window.picked');
    recording = false; await record;
      const { PNG } = require('pngjs');
      const { GifWriter } = require('omggif');
      const images = frames.map(f=>PNG.sync.read(f));
      const { width, height } = images[0];
      if (images.some(im => im.width !== width || im.height !== height)) throw new Error('GIF frame dimensions must match');
      const counts = new Map();
      for (const im of images) for(let i=0;i<im.data.length;i+=4) { const c=(im.data[i]<<16)|(im.data[i+1]<<8)|im.data[i+2];counts.set(c,(counts.get(c)||0)+1); }
      const palette=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,256).map(p=>p[0]);while(palette.length<256)palette.push(0);
      const cache=new Map();const nearest=c=>{if(cache.has(c))return cache.get(c);let best=0,dist=Infinity;palette.forEach((p,j)=>{const d=((c>>16)-(p>>16))**2+(((c>>8)&255)-((p>>8)&255))**2+((c&255)-(p&255))**2;if(d<dist){dist=d;best=j}});cache.set(c,best);return best};
      const buffer=Buffer.alloc(images.length*width*height*2+4096);const gif=new GifWriter(buffer,width,height,{loop:0,palette});
      for(const im of images){const pixels=Buffer.alloc(width*height);for(let i=0;i<pixels.length;i++)pixels[i]=nearest((im.data[i*4]<<16)|(im.data[i*4+1]<<8)|im.data[i*4+2]);gif.addFrame(0,0,width,height,pixels,{delay:8});}
      fs.writeFileSync(path.join(out,'reorder.gif'),buffer.subarray(0,gif.end()));

    report.focused = win.isFocused();
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(report, null, 2)); console.log(report);
    const assert = require('node:assert/strict');
    assert.equal(report.starRows, process.env.NEKKO_TEST_SOURCE ? 1 : 2);
    assert.equal(report.clickLift, false);
    assert.equal(report.stationaryDragLift, !!process.env.NEKKO_TEST_SOURCE);
    assert.equal(report.movedDragLift, true);
    assert.equal(report.cancelled, true);
    assert.equal(report.selected, 'star');
    assert.equal(report.focused, false);
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { win.destroy(); app.exit(process.exitCode || 0); }
});
