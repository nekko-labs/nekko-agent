// Evidence for the tool-row hover card: a still in dark and light, then a GIF of
// hovering a row, moving into the card and scrolling its details. Hidden,
// off-screen, non-focusable (show: false, never shown). Launch through
// tool-hover-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { GifWriter } = require('omggif');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through tool-hover-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/** Encode BGRA bitmaps (Electron's toBitmap order) as a GIF with the frames' most common colors. */
function writeGif(file, frames, width, height, delayCs) {
  const q = (f, i) => ((f[i + 2] >> 3) << 10) | ((f[i + 1] >> 3) << 5) | (f[i] >> 3);
  const counts = new Map();
  for (const f of frames) for (let i = 0; i < f.length; i += 16) { const k = q(f, i); counts.set(k, (counts.get(k) || 0) + 1); }
  const palette = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => k);
  while (palette.length < 256) palette.push(0);
  const nearest = new Map();
  const pick = (k) => {
    if (!nearest.has(k)) {
      let best = 0, bestD = Infinity;
      palette.forEach((p, i) => { const d = (((p >> 10) & 31) - ((k >> 10) & 31)) ** 2 + (((p >> 5) & 31) - ((k >> 5) & 31)) ** 2 + ((p & 31) - (k & 31)) ** 2; if (d < bestD) { bestD = d; best = i; } });
      nearest.set(k, best);
    }
    return nearest.get(k);
  };
  const buf = Buffer.alloc(width * height * frames.length * 2 + 1024 * 1024);
  const gif = new GifWriter(buf, width, height, { palette: palette.map((k) => (((k >> 10) & 31) << 19) | (((k >> 5) & 31) << 11) | ((k & 31) << 3)), loop: 0 });
  for (const f of frames) {
    const idx = new Uint8Array(width * height);
    for (let p = 0; p < idx.length; p++) idx[p] = pick(q(f, p * 4));
    gif.addFrame(0, 0, width, height, idx, { delay: delayCs });
  }
  fs.writeFileSync(file, buf.subarray(0, gif.end()));
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file:|data:)/.test(d.url) }));
  const win = new BrowserWindow({ width: 900, height: 650, show: false, focusable: false, webPreferences: { backgroundThrottling: false } });
  const report = { bounds: null, shown: null, themes: {}, scroll: null, errors: [] };
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(600);
    const run = (code) => win.webContents.executeJavaScript(code);
    const move = async (p) => { win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) }); };
    const tip = () => run(`(()=>{const t=document.querySelector('[role=tooltip]');if(!t)return null;const b=t.getBoundingClientRect();const pre=t.querySelector('pre');return {heading:t.querySelector('.hover-tip-heading')?.textContent??null,text:pre?.textContent??t.textContent,x:b.x,y:b.y,width:b.width,height:b.height,scrollTop:pre?.scrollTop??0,scrollable:pre?pre.scrollHeight>pre.clientHeight:false}})()`);
    // The write_file row (step 2) has the long input.
    const row = (n) => run(`(()=>{const b=document.querySelectorAll('ol li button')[${js(n)}].getBoundingClientRect();return {x:b.x+80,y:b.y+b.height/2}})()`);
    const away = { x: 880, y: 630 };

    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme=${js(theme)}`);
      await move(away); await sleep(300);
      await move(await row(1)); await sleep(700);
      fs.writeFileSync(path.join(out, `hover-${theme}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      report.themes[theme] = await tip();
    }

    // Recording (dark): hover in, move into the card, scroll its details.
    await run(`document.documentElement.dataset.theme='dark'`);
    await move(away); await sleep(400);
    const frames = [];
    const grab = async (n, gap) => { for (let i = 0; i < n; i++) { frames.push((await win.capturePage(undefined, { stayHidden: true })).toBitmap()); await sleep(gap); } };
    await grab(4, 60);
    const start = await row(1);
    await move(start); await grab(10, 60);
    const card = await tip();
    // A revision without the card (the base for "before" shots) has nothing to record.
    if (!card) return;
    // Glide from the row into the card's details box, through the gap between them.
    const target = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
    for (let i = 1; i <= 8; i++) { await move({ x: start.x + (target.x - start.x) * i / 8, y: start.y + (target.y - start.y) * i / 8 }); await grab(1, 30); }
    for (let i = 0; i < 14; i++) { win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(target.x), y: Math.round(target.y), deltaX: 0, deltaY: -60, canScroll: true }); await grab(1, 50); }
    await grab(6, 60);
    report.scroll = await tip();
    const size = (await win.capturePage(undefined, { stayHidden: true })).getSize();
    writeGif(path.join(out, 'hover-scroll.gif'), frames, size.width, size.height, 8);
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally {
    report.bounds = win.getBounds();
    report.shown = win.isVisible();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, themes: Object.fromEntries(Object.entries(report.themes).map(([k, v]) => [k, v && { ...v, text: v.text.slice(0, 80) }])), scroll: report.scroll && { ...report.scroll, text: undefined } }, null, 2));
    win.destroy(); app.exit(process.exitCode || 0);
  }
});
