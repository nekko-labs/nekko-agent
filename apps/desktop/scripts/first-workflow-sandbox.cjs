const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use first-workflow-integration.cjs');
const profile = fs.mkdtempSync(path.join(out, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const report = { checks: [], errors: [], captures: [] };
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, x: -5000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const frames = [];
  const record = async () => {
    for (let i = 0; i < 4; i++) {
      const image = (await win.capturePage(undefined, { stayHidden: true })).resize({ width: 640 });
      frames.push(require('pngjs').PNG.sync.read(image.toPNG()));
      await sleep(150);
    }
  };
  const check = async (name, s) => report.checks.push({ name, passed: !!await run(s) });
  const capture = async name => {
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  try {
    for (const [label, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
      win.setContentSize(width, height);
      await win.loadFile(path.join(out, 'index.html')); await sleep(800);
      await capture(label + '-start');
      if (win.isVisible() || win.isFocusable()) throw Error('Unsafe fixture window');
      if (process.env.NEKKO_TEST_LABEL !== 'before') {
        if (label === 'desktop') await record();
        await check(label + ': no horizontal overflow', 'document.documentElement.scrollWidth <= innerWidth');
        await run("document.querySelector('[data-workflow-category=shopping] summary').click()"); await sleep(200);
        await capture(label + '-shopping');
        if (label === 'phone') {
          await run("document.querySelector('[data-workflow-category=shopping]').scrollIntoView({block:'start'})"); await sleep(100);
          await capture(label + '-shopping-detail');
        }
        if (label === 'desktop') await record();
        await run("document.querySelector('[data-workflow-example=stock]').click()"); await sleep(200);
        await capture(label + '-personalize');
        if (label === 'desktop') await record();
        await check(label + ': requires a URL', "document.querySelector('[data-workflow-continue]').disabled");
        await run("(()=>{const el=document.querySelector('[data-workflow-detail]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'https://example.com/product');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
        await sleep(150);
        await run("document.querySelector('[data-workflow-continue]').scrollIntoView({block:'end'})"); await sleep(100);
        await check(label + ': Continue reachable in scroll area', "(()=>{const r=document.querySelector('[data-workflow-continue]').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()");
        if (label === 'phone') await capture(label + '-personalize-continue');
        await run("document.querySelector('[data-workflow-continue]').click()"); await sleep(400);
        await capture(label + '-editor');
        if (label === 'desktop') await record();
        await check(label + ': editable prompt carries URL', "document.body.innerText.includes('Create workflow') && [...document.querySelectorAll('textarea')].some(e=>e.value.includes('https://example.com/product'))");
        await check(label + ': nothing created or run', 'window.workflowEvidence.calls.length === 0');
      }
    }
    if (process.env.NEKKO_TEST_LABEL !== 'before') {
      for (const scene of ['loading', 'error', 'existing']) {
        await win.loadFile(path.join(out, 'index.html'), { query: { scene } }); await sleep(300);
        await check(scene + ': no wizard', '!document.querySelector("[data-first-workflow-wizard]")');
        await check(scene + ': correct state', scene === 'existing' ? "!!document.querySelector('[data-workflow-row=existing]')" : `document.body.innerText.includes('${scene === 'loading' ? 'Loading workflows' : 'Could not load workflows'}')`);
        if (scene === 'existing') {
          await run("(()=>{const el=document.querySelector('input[placeholder]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'No match');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
          await sleep(150);
          await check('filtered empty: no wizard', "!document.querySelector('[data-first-workflow-wizard]') && document.body.innerText.includes('Nothing matches those filters')");
        }
      }
      // Keyboard-accessible disclosure and Back keep the chosen category.
      await win.loadFile(path.join(out, 'index.html')); await sleep(300);
      await run("document.querySelector('[data-workflow-category=developer] summary').focus()");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' }); await sleep(200);
      await check('keyboard opens category', "document.querySelector('[data-workflow-category=developer]').open");
      await run("document.querySelector('[data-workflow-example=prs]').click()"); await sleep(200);
      await check('review explains connection requirement', "document.body.innerText.includes('GitHub access and a project folder')");
      await run("document.querySelector('[data-workflow-personalize] button').click()"); await sleep(200);
      await check('Back preserves category', "document.querySelector('[data-workflow-category=developer]').open");
      await run("[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Browse all templates')).click()"); await sleep(200);
      await check('template escape hatch', "document.body.innerText.includes('Ready to use') && document.body.innerText.includes('Blank workflow')");
      await check('all navigation remains local', 'window.workflowEvidence.calls.length === 0');
      encodeRecording(frames, path.join(out, 'desktop-wizard-walkthrough.gif'));
    }
    report.window = { bounds: win.getBounds(), visible: win.isVisible(), focusable: win.isFocusable() };
    if (win.isVisible() || win.isFocusable()) report.errors.push('Unsafe fixture window');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  await session.defaultSession.clearStorageData();
  app.exit(report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });

// Adaptive palette from captured frames preserves the default theme colors.
function encodeRecording(frames, file) {
  const { GifWriter } = require('omggif');
  const histogram = new Map();
  for (const frame of frames) for (let i = 0; i < frame.data.length; i += 4) {
    const color = (frame.data[i] << 16) | (frame.data[i + 1] << 8) | frame.data[i + 2];
    histogram.set(color, (histogram.get(color) || 0) + 1);
  }
  const palette = [...histogram].sort((a, b) => b[1] - a[1]).slice(0, 256).map(x => x[0]);
  while (palette.length < 256) palette.push(0);
  const cache = new Map();
  const index = color => {
    if (cache.has(color)) return cache.get(color);
    let best = Infinity, result = 0;
    palette.forEach((p, i) => {
      const distance = ((color >> 16) - (p >> 16)) ** 2 + (((color >> 8) & 255) - ((p >> 8) & 255)) ** 2 + ((color & 255) - (p & 255)) ** 2;
      if (distance < best) { best = distance; result = i; }
    });
    cache.set(color, result); return result;
  };
  const { width, height } = frames[0];
  const buffer = Buffer.alloc(width * height * frames.length * 2 + 1_000_000);
  const writer = new GifWriter(buffer, width, height, { loop: 0, palette });
  for (const frame of frames) {
    const pixels = new Uint8Array(width * height);
    for (let i = 0; i < pixels.length; i++) {
      const offset = i * 4;
      pixels[i] = index((frame.data[offset] << 16) | (frame.data[offset + 1] << 8) | frame.data[offset + 2]);
    }
    writer.addFrame(0, 0, width, height, pixels, { delay: 15, disposal: 1 });
  }
  fs.writeFileSync(file, buffer.subarray(0, writer.end()));
}
