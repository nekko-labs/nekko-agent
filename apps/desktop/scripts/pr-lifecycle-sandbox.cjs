// Hidden renderer-only fixture. No host, user profile, network or OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { captures: [], checks: [], errors: [], safety: {} };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(details.url) }));
  session.defaultSession.setPermissionRequestHandler((_web, _permission, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(display => display.bounds.x));
  const minY = Math.min(...screen.getAllDisplays().map(display => display.bounds.y));
  const win = new BrowserWindow({ width: 1000, height: 1100, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1500, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message.slice(0, 400)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => {
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    // Hidden-window capture can return the preceding compositor frame once.
    await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    await sleep(100);
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    report.captures.push(file);
  };
  const inspect = async name => {
    const check = await run(`(() => ({ events: Array.from(document.querySelectorAll('[data-pr-event]')).map(e => e.dataset.prEvent), labels: Array.from(document.querySelectorAll('[data-pr-event]')).map(e => e.innerText), overflow: document.documentElement.scrollWidth > innerWidth, cardsOverflow: Array.from(document.querySelectorAll('[data-pr-event]')).some(e => e.scrollWidth > e.clientWidth + 1) }))()`);
    report.checks.push({ name, ...check });
    if (check.overflow || check.cardsOverflow) throw Error(`Horizontal overflow: ${name}`);
    return check;
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture?.showPrLifecycle')); i++) await sleep(100);
    await run('layoutFixture.showPrLifecycle()');
    await sleep(900);
    for (const width of [1000, 390]) {
      win.setContentSize(width, 1100); await sleep(400);
      await shot(`history-${width}`); await inspect(`history-${width}`);
    }
    win.setContentSize(1000, 1100);
    await run('layoutFixture.showPrLifecycle(true)'); await sleep(600);
    const frames = [];
    for (let index = 0; index < 4; index++) {
      await run(`layoutFixture.lifecycle.emit(${index})`); await sleep(500);
      await shot(`live-${index}`); await inspect(`live-${index}`);
      frames.push((await win.capturePage(undefined, { stayHidden: true })).toPNG());
    }
    const beforeFinish = await inspect('before-finish');
    if (beforeFinish.events.length) {
      await run(`document.querySelector('[data-pr-event] a').click()`);
      report.openedUrl = await run('layoutFixture.lifecycle.openedUrl');
      if (report.openedUrl !== 'https://github.com/example/project/pull/42') throw Error('Wrong PR link');
      report.liveActionCards = await run('document.querySelectorAll("[data-pr-actions]").length');
      if (report.liveActionCards !== 1) throw Error('Expected one live action card');
    }
    await run('layoutFixture.lifecycle.finish()'); await sleep(900);
    const afterFinish = await inspect('after-finish');
    await shot('after-finish');
    report.sameEventsAfterFinish = JSON.stringify(beforeFinish.events) === JSON.stringify(afterFinish.events);
    frames.push((await win.capturePage(undefined, { stayHidden: true })).toPNG());
    const { PNG } = require('pngjs'); const { GifWriter } = require('omggif');
    const images = frames.map(buffer => PNG.sync.read(buffer));
    const counts = new Map();
    for (const image of images) for (let i = 0; i < image.data.length; i += 4) {
      const rgb = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2]; counts.set(rgb, (counts.get(rgb) || 0) + 1);
    }
    const palette = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([rgb]) => rgb); while (palette.length < 256) palette.push(0);
    const nearest = new Map(palette.map((rgb, index) => [rgb, index]));
    const buffer = Buffer.alloc(images[0].width * images[0].height * images.length * 2);
    const writer = new GifWriter(buffer, images[0].width, images[0].height, { palette, loop: 0 });
    for (const image of images) {
      const indexed = new Uint8Array(image.width * image.height);
      for (let pixel = 0; pixel < indexed.length; pixel++) {
        const i = pixel * 4, r = image.data[i], g = image.data[i + 1], b = image.data[i + 2], rgb = (r << 16) | (g << 8) | b;
        let index = nearest.get(rgb);
        if (index === undefined) {
          let distance = Infinity; index = 0;
          for (let p = 0; p < palette.length; p++) { const color = palette[p], d = (r - (color >> 16)) ** 2 + (g - ((color >> 8) & 255)) ** 2 + (b - (color & 255)) ** 2; if (d < distance) { distance = d; index = p; } }
          nearest.set(rgb, index);
        }
        indexed[pixel] = index;
      }
      writer.addFrame(0, 0, image.width, image.height, indexed, { delay: 70 });
    }
    fs.writeFileSync(path.join(out, 'live-lifecycle.gif'), buffer.subarray(0, writer.end()));
    report.safety = { visible: win.isVisible(), focusable: win.isFocusable(), focused: win.isFocused(), bounds: win.getBounds() };
    if (report.safety.visible || report.safety.focusable || report.safety.focused) throw Error('Unsafe fixture window');
  } catch (error) { report.errors.push(String(error.stack || error)); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(process.exitCode || 0);
});
