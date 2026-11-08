// Hidden renderer evidence with an isolated profile and all network denied.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const { PNG } = require('pngjs');
const { GifWriter } = require('omggif');
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], assertions: [], captures: [] };
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const assert = async (name, code) => { if (!await run(code)) throw Error(name); report.assertions.push(name); };
  const shot = async name => { await sleep(300); fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let n = 0; n < 50 && !await run("!!document.querySelector('.customize-content')"); n++) await sleep(100);
    await assert('Customize opens', "!!document.querySelector('.customize-content')");
    await shot('desktop');
    win.setContentSize(390, 844); await sleep(400);
    await shot('narrow');
    if (process.env.NEKKO_OUTPUT_ASSERT === '1') {
      for (const level of ['minimal', 'regular', 'detailed']) {
        await run(`document.querySelector('[data-detail-level="${level}"]').click()`);
        await assert(`${level} selected`, `document.querySelector('[data-detail-level="${level}"]').getAttribute('aria-checked') === 'true'`);
        await assert(`${level} persisted`, `localStorage.getItem('nekko.chatMode') === '${level === 'detailed' ? 'expert' : 'simple'}' && ${level === 'minimal' ? "['changes','suggest','context'].every(id => JSON.parse(localStorage.getItem('nekko.simpleChoices'))[id] === 'hide')" : "['changes','suggest','context'].every(id => !JSON.parse(localStorage.getItem('nekko.simpleChoices'))[id])"}`);
        await assert(`${level} preview`, `!!document.querySelector('[aria-label="Preview of a chat in ${level}"]')`);
      }
      await assert('unrelated choices preserved', "JSON.parse(localStorage.getItem('nekko.simpleChoices')).asks === 'hide' && JSON.parse(localStorage.getItem('nekko.simpleChoices')).cost === 'show'");
      await assert('no horizontal overflow', "document.querySelector('.customize-panel').scrollWidth <= document.querySelector('.customize-panel').clientWidth");
      await run("document.querySelector('[data-detail-level=regular]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true}))");
      await assert('keyboard chooses Minimal', "document.querySelector('[data-detail-level=minimal]').getAttribute('aria-checked') === 'true'");
      await run("document.querySelector('[aria-label=\"Close Customize\"]').click(); outputFixture.openCustomize()");
      await sleep(200);
      await assert('reopen restores Minimal', "document.querySelector('[data-detail-level=minimal]').getAttribute('aria-checked') === 'true'");
      await assert('no host settings changed by detail', 'outputFixture.patches.length === 0');
      await shot('narrow-minimal');
      win.setContentSize(1280, 900); await sleep(300);
      await run("document.querySelector('[data-detail-level=detailed]').click()");
      await sleep(7500); await shot('desktop-detailed');
      await run("document.querySelector('.customize-panel').scrollTop = 180; document.querySelector('.output-detail-playback').click()");
      const pausedText = await run("document.querySelector('.output-detail-preview').innerText");
      await sleep(600);
      if (pausedText !== await run("document.querySelector('.output-detail-preview').innerText")) throw Error('Preview changed while paused');
      report.assertions.push('pause stops replay');
      await run("document.querySelector('.output-detail-playback').click(); document.querySelector('[data-detail-level=regular]').click()");
      const frames = [];
      for (let n = 0; n < 22; n++) {
        await sleep(350);
        frames.push(PNG.sync.read((await win.capturePage(undefined, { stayHidden: true })).resize({ width: 768 }).toPNG()));
      }
      // Palette from the actual frames, with a cached nearest-color mapping.
      const histogram = new Map();
      for (const frame of frames) for (let i = 0; i < frame.data.length; i += 4) {
        const rgb = (frame.data[i] << 16) | (frame.data[i + 1] << 8) | frame.data[i + 2];
        histogram.set(rgb, (histogram.get(rgb) || 0) + 1);
      }
      const palette = [...histogram].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([rgb]) => rgb);
      while (palette.length < 256) palette.push(0);
      const nearest = new Map();
      const buffer = Buffer.alloc(32 * 1024 * 1024);
      const gif = new GifWriter(buffer, frames[0].width, frames[0].height, { loop: 0, palette });
      for (const frame of frames) {
        const indices = new Uint8Array(frame.width * frame.height);
        for (let p = 0; p < indices.length; p++) {
          const i = p * 4, r = frame.data[i], g = frame.data[i + 1], b = frame.data[i + 2];
          const rgb = (r << 16) | (g << 8) | b;
          if (!nearest.has(rgb)) {
            let best = 0, distance = Infinity;
            for (let c = 0; c < palette.length; c++) {
              const color = palette[c];
              const d = (r - (color >> 16)) ** 2 + (g - ((color >> 8) & 255)) ** 2 + (b - (color & 255)) ** 2;
              if (d < distance) { distance = d; best = c; }
            }
            nearest.set(rgb, best);
          }
          indices[p] = nearest.get(rgb);
        }
        gif.addFrame(0, 0, frame.width, frame.height, indices, { delay: 35 });
      }
      fs.writeFileSync(path.join(out, 'output-preview.gif'), buffer.subarray(0, gif.end()));
      await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await run("document.querySelector('[data-detail-level=detailed]').click()"); await sleep(200);
      const reducedText = await run("document.querySelector('.output-detail-preview').innerText");
      await sleep(600);
      await assert('reduced motion finishes sample', "document.querySelector('.output-detail-preview').innerText.includes('all 48 tests pass now.')");
      if (reducedText !== await run("document.querySelector('.output-detail-preview').innerText")) throw Error('Reduced-motion preview animated');
      report.assertions.push('reduced motion stays static');
      await shot('reduced-motion');
      win.setContentSize(390, 844);
      await run("document.querySelector('.output-detail-preview').scrollIntoView({block: 'start'})");
      await sleep(200); await shot('narrow-detailed');
      await assert('narrow detailed answer is reachable', "document.querySelector('[aria-label=\"Preview of a chat in detailed\"] p').textContent.includes('all 48 tests pass now.')");
    }
    await run("localStorage.setItem('nekko.chatMode', 'simple'); outputFixture.showMode()"); await sleep(200);
    await shot('labeled-switch');
    if (process.env.NEKKO_OUTPUT_ASSERT === '1') {
      await assert('icons and labels share a row', `[...document.querySelectorAll('.mode-seg-labels button')].every(b => {
        const icon = b.querySelector('svg').getBoundingClientRect(), label = b.querySelector('span').getBoundingClientRect();
        return icon.right <= label.left && Math.abs((icon.top + icon.height / 2) - (label.top + label.height / 2)) < 2;
      })`);
    }
    report.hidden = !win.isVisible();
    report.bounds = win.getBounds();
  } catch (e) { report.errors.push(String(e.stack || e)); process.exitCode = 1; }
  if (report.errors.length || !report.hidden) process.exitCode = 1;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(process.exitCode || 0);
});
