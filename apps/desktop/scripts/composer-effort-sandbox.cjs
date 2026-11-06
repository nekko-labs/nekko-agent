const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], assertions: {}, errors: [] };
const assert = require('node:assert/strict');
const before = !!process.env.NEKKO_TEST_REVISION;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run('!!window.composerFixture && !!document.querySelector("[data-model-chip-name]")')); i++) await sleep(200);
    await run("localStorage.setItem('nekko.chatMode','simple')"); await win.reload(); await sleep(1500); await run("document.querySelector('[contenteditable=plaintext-only]').focus()"); await win.webContents.insertText("Make this better and fix everything"); await sleep(500);
    if (!before) assert.equal(await run('document.querySelectorAll("[data-prompt-suggestions]").length'), 0, 'Simple hides prompt suggestions');
    await shot('simple');
    await run('document.querySelector("button[aria-haspopup=listbox]").click()'); await sleep(600);
    await shot('models');
    report.assertions.columns = await run('Array.from(document.querySelectorAll("[data-model-scroll]")).map(e=>({source:e.dataset.modelScroll,height:e.clientHeight,scroll:e.scrollHeight}))');
    report.assertions.defaultCount = await run('Array.from(document.querySelectorAll("[role=option]")).filter(e=>e.textContent.includes("Default")).length');
    const columns = await run('document.querySelectorAll("[data-model-scroll]").length');
    if (columns === 2) {
      await run('document.querySelectorAll("[data-model-scroll]")[0].scrollTop=200');
      report.assertions.scroll = await run('Array.from(document.querySelectorAll("[data-model-scroll]")).map(e=>e.scrollTop)');
      await shot('models-scrolled');
      const frames = [];
      for (let i = 0; i < 10; i++) {
        await run(`document.querySelectorAll('[data-model-scroll]')[0].scrollTop=${i * 60}`);
        await sleep(100);
        frames.push((await win.capturePage(undefined, { stayHidden: true })).resize({ width: 700 }).toPNG());
      }
      const modules = process.env.NEKKO_TEST_MODULES;
      const { PNG } = require(path.join(modules, 'pngjs'));
      const { GifWriter } = require(path.join(modules, 'omggif'));
      const images = frames.map(f => PNG.sync.read(f));
      const counts = new Map();
      for (const image of images) for (let i = 0; i < image.data.length; i += 4) { const rgb = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2]; counts.set(rgb, (counts.get(rgb) || 0) + 1); }
      const palette = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([rgb]) => rgb);
      while (palette.length < 256) palette.push(0);
      const nearest = new Map();
      const data = Buffer.alloc(images[0].width * images[0].height * images.length * 2);
      const gif = new GifWriter(data, images[0].width, images[0].height, { loop: 0, palette });
      for (const image of images) {
        const indices = new Uint8Array(image.width * image.height);
        for (let i = 0; i < indices.length; i++) {
          const r = image.data[i * 4], g = image.data[i * 4 + 1], b = image.data[i * 4 + 2], rgb = (r << 16) | (g << 8) | b;
          if (!nearest.has(rgb)) { let best = 0, distance = Infinity; palette.forEach((p, n) => { const d = (r - (p >> 16)) ** 2 + (g - ((p >> 8) & 255)) ** 2 + (b - (p & 255)) ** 2; if (d < distance) { best = n; distance = d; } }); nearest.set(rgb, best); }
          indices[i] = nearest.get(rgb);
        }
        gif.addFrame(0, 0, image.width, image.height, indices, { delay: 15 });
      }
      fs.writeFileSync(path.join(out, 'independent-scroll.gif'), data.subarray(0, gif.end()));
    }
    await run('document.querySelector("button[aria-haspopup=listbox]").click()');
    const effort = await run('!!document.querySelector(".effort-slider button:not(:disabled)")');
    if (effort) {
      await run('document.querySelector(".effort-slider button").click()'); await sleep(200); await shot('effort');
      const slider = await run('!!document.querySelector("[data-effort-popover] input[type=range]")');
      if (slider) {
        await run('document.querySelector("[data-effort-popover] input[type=range]").focus()');
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End' });
        await sleep(250);
        report.assertions.savedEffort = await run('composerFixture.record.effort');
        await shot('effort-selected');
      }
      await run('document.querySelector(".effort-slider button").click()');
    }
    await run("localStorage.setItem('nekko.chatMode','expert')"); await win.reload(); await sleep(1500); await run("document.querySelector('[contenteditable=plaintext-only]').focus()"); await win.webContents.insertText("Make this better and fix everything"); await sleep(500);
    if (!before) {
      assert.equal(await run('document.querySelectorAll("[data-prompt-suggestions]").length'), 1, 'one suggestions control in Detailed');
      assert.equal(await run('!!document.querySelector("[data-composer-suggestions] [data-prompt-suggestions]")'), true, 'suggestions stay in their separate row');
    }
    await shot('expert');
    win.setContentSize(420, 800); await sleep(250); await shot('narrow');
    await run('document.querySelector("button[aria-haspopup=listbox]").click()'); await sleep(250); await shot('narrow-models');
    report.assertions.viewportOverflow = await run('document.documentElement.scrollWidth > innerWidth');
    assert.equal(report.assertions.viewportOverflow, false);
    if (!before) {
      assert.equal(report.assertions.columns.length, 2);
      assert.ok(report.assertions.columns.every(column => column.scroll > column.height));
      assert.equal(report.assertions.defaultCount, 1);
      assert.deepEqual(report.assertions.scroll, [200, 0]);
      assert.equal(report.assertions.savedEffort, 'ultra');
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.captures.length && !report.errors.length ? 0 : 1);
});
