const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const report = {};
  const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await run("(async()=>{await layoutFixture.showComposer('full', true);layoutFixture.store.setState({running:new Set()})})()");
    await sleep(1600);
    report.initial = await run("document.querySelector('[data-clean-start-greeting] h2')?.textContent");
    await shot('greeting-desktop');
    const frames = [];
    for (let i = 0; i < 10; i++) {
      frames.push((await win.capturePage(undefined, { stayHidden: true })).resize({ width: 640 }).toPNG());
      await sleep(1000);
    }
    const { PNG } = require('pngjs');
    const { GifWriter } = require('omggif');
    const images = frames.map(f => PNG.sync.read(f));
    const counts = new Map();
    const color = (d, i) => (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    for (const { data } of images) for (let i = 0; i < data.length; i += 4) { const c = color(data, i); counts.set(c, (counts.get(c) || 0) + 1); }
    const palette = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([c]) => c);
    while (palette.length < 256) palette.push(0);
    const nearest = new Map();
    const buf = Buffer.alloc(images[0].width * images[0].height * images.length * 2);
    const gif = new GifWriter(buf, images[0].width, images[0].height, { loop: 0 });
    for (const image of images) {
      const pixels = new Uint8Array(image.width * image.height);
      for (let j = 0; j < pixels.length; j++) {
        const c = color(image.data, j * 4);
        if (!nearest.has(c)) {
          let best = 0, distance = Infinity;
          palette.forEach((p, k) => { const d = ((c >> 16) - (p >> 16)) ** 2 + (((c >> 8) & 255) - ((p >> 8) & 255)) ** 2 + ((c & 255) - (p & 255)) ** 2; if (d < distance) { distance = d; best = k; } });
          nearest.set(c, best);
        }
        pixels[j] = nearest.get(c);
      }
      gif.addFrame(0, 0, image.width, image.height, pixels, { palette, delay: 100 });
    }
    fs.writeFileSync(path.join(out, 'greeting-timing.gif'), buf.subarray(0, gif.end()));
    report.later = await run("document.querySelector('[data-clean-start-greeting] h2')?.textContent");
    await run("window.folderCalls=0; layoutFixture.bridge.pickFolder=async()=>{window.folderCalls++; return null}; document.querySelector('[aria-label^=\"Selected folders:\"], [aria-label^=\"Primary folder:\"]')?.click()");
    await sleep(300);
    await shot('folders-desktop');
    report.menu = await run("Array.from(document.querySelectorAll('[role=menu] button')).map(b=>({text:b.textContent,rect:b.getBoundingClientRect().toJSON()}))");
    const point = await run("(()=>{const b=Array.from(document.querySelectorAll('[role=menu] button')).find(b=>b.textContent.includes('Add folder')); if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
    if(point){ win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1}); }
    await sleep(300);
    report.folderCalls = await run('window.folderCalls');
    if (!report.initial || !report.later) throw Error('Missing greeting');
    if (process.env.NEKKO_TEST_LABEL?.includes('after') && report.initial !== report.later) throw Error('Greeting rotated');
    if (report.folderCalls !== 1) throw Error('Folder click did not reach picker exactly once');
    win.setSize(460,900); await sleep(400); await shot('greeting-narrow');
  } catch(e) {report.error=String(e.stack||e);}
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(report);app.exit(report.error?1:0);
});
