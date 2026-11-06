// Real renderer, synthetic deferred bridge, no daemon or external network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with ci-runners-integration.cjs');
const dir = path.join(out, 'after');
fs.mkdirSync(dir, { recursive: true });
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const baseline = process.env.NEKKO_CI_BASELINE === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = v => JSON.stringify(v).replace(/[<>\/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
app.whenReady().then(async () => {
  const report = { baseline, checks: [], errors: [], captures: [] };
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, title: 'Isolated CI save verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  win.on('show', () => report.errors.push('Window was shown'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, source) => report.checks.push({ name, passed: !!await run(source) });
  const capture = async name => {
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw Error('Empty screenshot');
    const file = path.join(dir, name + '.png');
    fs.writeFileSync(file, image.toPNG()); report.captures.push(file);
  };
  const button = text => `[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()===${js(text)})`;
  const click = text => run(`${button(text)}?.click()`);
  const scroll = () => run("document.querySelector('[role=dialog]')?.scrollTo(0,10000)");
  const open = async () => {
    await run("integration.show('settings-save')"); await sleep(250);
    await run("document.querySelector('[aria-label^=\"Runner settings for\"]')?.click()"); await sleep(250);
    await scroll(); await sleep(150);
  };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(500);
    await open();
    await click('30 min');
    await capture('settings-idle');
    await click('Save'); await sleep(150);
    await capture('settings-saving');
    await check('pending disables Save', `${button('Saving…')}?.disabled`);
    await click('Saving…');
    await check('no duplicate request', 'saveTest.calls===1');
    await check('only edited field submitted', 'saveTest.patch.maxJobMinutes===30 && Object.keys(saveTest.patch).length===1');
    if (!baseline) {
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await click('Cancel'); await sleep(100);
      await check('pending cannot dismiss the save', "!!document.querySelector('[role=dialog]')");
      await check('pending freezes edits', "document.querySelector('[role=dialog] fieldset')?.disabled");
    }
    await run("saveTest.reject(new Error('The service is unavailable. Try again.'))"); await sleep(200);
    await capture('settings-error');
    await check('failure keeps dialog and edits', "!!document.querySelector('[role=dialog]') && [...document.querySelectorAll('[aria-pressed=true]')].some(e=>e.textContent==='30 min')");
    if (!baseline) await check('failure is inline', "document.querySelector('[role=dialog] [role=alert]')?.textContent.includes('The service is unavailable')");
    await click('Save'); await sleep(150);
    if (!baseline) await check('retry clears old error', "!document.querySelector('[role=dialog] [role=alert]')");
    await run('saveTest.resolve()'); await sleep(250);
    await capture('settings-success');
    await check(baseline ? 'baseline success incorrectly leaves dialog open' : 'success closes only after reply', baseline ? "!!document.querySelector('[role=dialog]')" : "!document.querySelector('[role=dialog]')");
    if (baseline) { await click('Cancel'); await sleep(150); }
    await run("document.querySelector('[aria-label^=\"Runner settings for\"]')?.click()"); await sleep(200);
    await check('saved settings survive reopen', "[...document.querySelectorAll('[aria-pressed=true]')].some(e=>e.textContent==='30 min')");
    await click('Cancel'); await sleep(150);
    await run("integration.show('missing-logs')"); await sleep(300);
    await run("document.querySelector('[data-recent-job] button')?.click()"); await sleep(150);
    await run("document.querySelector('[data-runner-card]')?.scrollIntoView({block:'start'})"); await sleep(200);
    await capture('missing-logs');
    if (!baseline) await check('missing logs explain recovery limits', "document.body.innerText.includes('cannot be recovered') && document.body.innerText.includes('on GitHub')");
    // Real elapsed-time frames for the save -> failure -> retry -> close sequence.
    await open();
    const frames = [];
    for (let i = 0; i < 24; i++) {
      if (i === 2 || i === 14) await click('Save');
      if (i === 9) await run("saveTest.reject(new Error('The service is unavailable. Try again.'))");
      if (i === 21) await run('saveTest.resolve()');
      await sleep(125);
      const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
      frames.push(image.toPNG());
    }
    // Use an installed encoder only; screenshots remain available independently.
    const { PNG } = require('pngjs');
    const { GifWriter } = require('omggif');
    const pngs = frames.map(f => PNG.sync.read(f));
    const counts = new Map();
    for (const p of pngs) for (let n = 0; n < p.data.length; n += 4) { const rgb = (p.data[n] << 16) | (p.data[n + 1] << 8) | p.data[n + 2]; counts.set(rgb, (counts.get(rgb) || 0) + 1); }
    const palette = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([rgb]) => rgb);
    while (palette.length < 256) palette.push(0);
    const indices = new Map();
    const nearest = rgb => {
      if (indices.has(rgb)) return indices.get(rgb);
      let best = 0, distance = Infinity;
      for (let i = 0; i < palette.length; i++) { const c = palette[i]; const d = ((rgb >> 16) - (c >> 16)) ** 2 + (((rgb >> 8) & 255) - ((c >> 8) & 255)) ** 2 + ((rgb & 255) - (c & 255)) ** 2; if (d < distance) { best = i; distance = d; } }
      indices.set(rgb, best); return best;
    };
    const bytes = Buffer.alloc(32 * 1024 * 1024);
    const gif = new GifWriter(bytes, pngs[0].width, pngs[0].height, { loop: 0, palette });
    for (const p of pngs) { const pixels = Buffer.alloc(p.width * p.height); for (let i = 0; i < pixels.length; i++) pixels[i] = nearest((p.data[i * 4] << 16) | (p.data[i * 4 + 1] << 8) | p.data[i * 4 + 2]); gif.addFrame(0, 0, p.width, p.height, pixels, { delay: 13 }); }
    fs.writeFileSync(path.join(dir, 'settings-save-flow.gif'), bytes.subarray(0, gif.end()));
    report.bounds = win.getBounds();
    if (win.isVisible()) report.errors.push('Window visible');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0);
});
