// Full App fixture, isolated profile, no network or OS input.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const before = process.env.NEKKO_BEFORE === '1';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Greeting peek isolated verification', width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [] };
  win.on('show', () => report.errors.push('Window shown'));
  win.on('focus', () => report.errors.push('Window focused'));
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = async (code, label) => { if (!await run(code)) throw Error(label); report.checks.push(label); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    // Hidden app pauses its entrance animation at opacity zero; settle it for stills.
    await win.webContents.insertCSS('.clean-start-greeting.fade-in { animation: none; opacity: 1; }');
    for (let n = 0; n < 60 && !await run('!!window.layoutFixture'); n++) await sleep(100);
    await run(`(() => { const s=layoutFixture.store.getState(); layoutFixture.store.setState({settings:{...s.settings,commandWall:{...s.settings.commandWall,layout:{...s.settings.commandWall?.layout,mode:'focus'}}}}); layoutFixture.store.getState().focusChatOnWall('d'); })()`);
    for (let n = 0; n < 60 && !await run('!!document.querySelector("[data-clean-start-greeting]")'); n++) await sleep(100);
    for (const [width, height] of [[1280, 900], [460, 900]]) {
      win.setContentSize(width, height); await sleep(700);
      await check(`document.querySelector('[data-clean-start-greeting] h2')?.textContent === 'What should we work on?'`, 'Greeting renders at ' + width);
      if (!before) {
        await check(`(() => { const svg=document.querySelector('.greeting-nekko'), composer=svg?.closest('.composer'); if(!svg||!composer)return false; const a=svg.getBoundingClientRect(),b=composer.getBoundingClientRect(); return Math.abs(a.top+50-b.top)<=2 && a.left>b.left && a.right<b.right && svg.getAttribute('aria-hidden')==='true'; })()`, 'Paws overlap actual composer edge at ' + width);
        await check(`(() => { const a=document.querySelector('.greeting-nekko').getBoundingClientRect(), b=document.querySelector('[data-clean-start-greeting] h2').getBoundingClientRect(); return a.right<=b.left || a.top>=b.bottom; })()`, 'Cat does not overlap heading at ' + width);
        await check(`!document.querySelector('.greeting-nekko path[d="M0 25H32"]')`, 'No artificial ledge at ' + width);
      }
      const file = path.join(out, 'greeting-' + width + '.png');
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file);
    }
    await run(`(() => { const ed=document.querySelector('.composer [contenteditable="plaintext-only"]'); ed.focus(); ed.textContent='Plan a small project with a friendly cat'; ed.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'})); ed.setSelectionRange(0,0); })()`);
    await sleep(500);
    await check(`document.querySelector('.composer [contenteditable="plaintext-only"]').value==='Plan a small project with a friendly cat'`, 'Composer accepts text');
    if (!before) {
      const start = await run(`document.querySelector('[data-nekko-look]').getAttribute('transform')`);
      await run(`document.querySelector('.composer [contenteditable="plaintext-only"]').setSelectionRange(38,38)`);
      await sleep(500);
      await check(`document.querySelector('[data-nekko-look]').getAttribute('transform') !== ${JSON.stringify(start)}`, 'Eyes follow selection movement');
      const { PNG } = require('pngjs');
      const { GifWriter } = require('omggif');
      const frames = [];
      for (const offset of [0, 8, 18, 28, 38, 28, 18, 8, 0]) {
        await run(`document.querySelector('.composer [contenteditable="plaintext-only"]').setSelectionRange(${offset},${offset})`);
        await sleep(120);
        frames.push(PNG.sync.read((await win.capturePage(undefined, {stayHidden:true})).toPNG()));
      }
      const colors = new Map();
      for(const f of frames) for(let i=0;i<f.data.length;i+=4){const c=(f.data[i]<<16)|(f.data[i+1]<<8)|f.data[i+2];colors.set(c,(colors.get(c)||0)+1);}
      const palette=[...colors].sort((a,b)=>b[1]-a[1]).slice(0,256).map(x=>x[0]); while(palette.length<256)palette.push(0);
      const cache=new Map();
      const buffer=Buffer.alloc(frames[0].width*frames[0].height*frames.length*2);
      const gif=new GifWriter(buffer,frames[0].width,frames[0].height,{palette,loop:0});
      for(const f of frames){const pixels=new Uint8Array(f.width*f.height);for(let i=0;i<pixels.length;i++){const c=(f.data[i*4]<<16)|(f.data[i*4+1]<<8)|f.data[i*4+2];if(!cache.has(c)){let best=0,dist=Infinity;for(let j=0;j<palette.length;j++){const p=palette[j],d=((c>>16)-(p>>16))**2+(((c>>8)&255)-((p>>8)&255))**2+((c&255)-(p&255))**2;if(d<dist){best=j;dist=d;}}cache.set(c,best);}pixels[i]=cache.get(c);}gif.addFrame(0,0,f.width,f.height,pixels,{delay:18});}
      fs.writeFileSync(path.join(out,'caret-gaze.gif'),buffer.subarray(0,gif.end()));
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    if (win.isVisible() || win.isFocused()) throw Error('Isolation failed');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.NEKKO_CAPTURE_HOLD === '1') await sleep(90000);
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
