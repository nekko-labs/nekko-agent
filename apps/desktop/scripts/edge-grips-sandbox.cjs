// Real wall renderer, synthetic records, isolated profile and no OS input.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through panel-grips-integration.cjs');
app.setPath('userData', path.join(out, 'edge-profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = value => JSON.stringify(value).replace(/</g, '\\u003c');
const report = { captures: [], facts: {}, errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1400, height: 820, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -1700, y: -1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took OS focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const facts = label => run(`(() => {
    const e = [...document.querySelectorAll('[role=separator]')].find(e => e.getAttribute('aria-label') === ${js(label)});
    if (!e) return null;
    const b = e.getBoundingClientRect(), g = e.querySelector('.pane-grip'), s = getComputedStyle(g);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, width: b.width, opacity: s.opacity, background: s.backgroundColor, hit: document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('[role=separator]') === e, value: e.getAttribute('aria-valuenow') };
  })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'), { search: 'quota' });
    await sleep(1600);
    report.facts.boundary = await run(`getComputedStyle(document.querySelector('.wall-agents-presence')).boxShadow`);
    await shot('rest-desktop');
    for (const [side, label] of [['left', 'Resize the agent list'], ['right', 'Resize monitors']]) {
      report.facts[side + '-rest'] = await facts(label);
      const g = await facts(label);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(g.x), y: Math.round(g.y) });
      await sleep(300);
      report.facts[side + '-hover'] = await facts(label);
      await shot(side + '-hover');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 650, y: 20 });
      await sleep(300);
    }
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    for (const [side, label] of [['left', 'Resize the agent list'], ['right', 'Resize monitors']]) {
      // Focus and keyboard resize through the existing accessible separator.
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await sleep(80);
      await run(`[...document.querySelectorAll('[role=separator]')].find(e => e.getAttribute('aria-label') === ${js(label)}).focus()`);
      await sleep(80);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
      await sleep(200);
      report.facts[side + '-keyboard'] = await facts(label);
      // Pointer drag must continue to work with the raised hit target.
      const p = await facts(label);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x + 24), y: Math.round(p.y) });
      await sleep(150);
      report.facts[side + '-drag'] = await facts(label);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(p.x + 24), y: Math.round(p.y), button: 'left', clickCount: 1 });
      await run('document.activeElement.blur()');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 650, y: 20 });
      await sleep(300);
      report.facts[side + '-leave'] = await facts(label);
    }
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
    win.webContents.debugger.detach();
    // A short real hover/leave clip, captured from the native renderer window.
    const { PNG } = require('pngjs');
    const { GifWriter } = require('omggif');
    const images = [];
    for (const side of ['left', 'right']) {
      const g = await facts(side === 'left' ? 'Resize the agent list' : 'Resize monitors');
      for (const hovering of [false, true, false]) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: hovering ? Math.round(g.x) : 650, y: hovering ? Math.round(g.y) : 20 });
        for (let i = 0; i < 3; i++) {
          await sleep(80);
          images.push(PNG.sync.read((await win.capturePage({ x: Math.max(0, Math.round(g.x) - 80), y: 80, width: 160, height: 600 }, { stayHidden: true })).toPNG()));
        }
      }
    }
    const { width, height } = images[0];
    const counts = new Map();
    for (const im of images) for (let i = 0; i < im.data.length; i += 4) {
      const c = (im.data[i] << 16) | (im.data[i + 1] << 8) | im.data[i + 2];
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    const palette = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256).map(p => p[0]);
    while (palette.length < 256) palette.push(0);
    const cache = new Map();
    const nearest = c => {
      if (cache.has(c)) return cache.get(c);
      let best = 0, dist = Infinity;
      palette.forEach((p, j) => {
        const d = ((c >> 16) - (p >> 16)) ** 2 + (((c >> 8) & 255) - ((p >> 8) & 255)) ** 2 + ((c & 255) - (p & 255)) ** 2;
        if (d < dist) { dist = d; best = j; }
      });
      cache.set(c, best);
      return best;
    };
    const buffer = Buffer.alloc(images.length * width * height * 2 + 4096);
    const gif = new GifWriter(buffer, width, height, { loop: 0, palette });
    for (const image of images) {
      const pixels = Buffer.alloc(width * height);
      for (let i = 0; i < pixels.length; i++) pixels[i] = nearest((image.data[i * 4] << 16) | (image.data[i * 4 + 1] << 8) | image.data[i * 4 + 2]);
      gif.addFrame(0, 0, width, height, pixels, { delay: 8 });
    }
    fs.writeFileSync(path.join(out, 'hover.gif'), buffer.subarray(0, gif.end()));
    for (const [side, label, closed] of [
      ['left', 'Hide the agent panel', '.wall-agents-presence'],
      ['right', 'Hide the monitors panel', '.monitors-dock'],
    ]) {
      await run(`document.querySelector('[aria-label="${label}"]').click()`);
      await sleep(350);
      report.facts[side + '-closed'] = await run(`(() => { const e = document.querySelector('${closed}'); return !e || (e.inert && getComputedStyle(e).pointerEvents === 'none' && getComputedStyle(e).clipPath === 'inset(0px)'); })()`);
    }
    await run(`document.querySelector('[aria-label="Show the agent panel"]').click(); document.querySelector('[aria-label="Show the monitors panel"]').click()`);
    await sleep(350);
    win.setContentSize(390, 844);
    await sleep(500);
    report.facts.mobile = await run('({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })');
    await shot('rest-mobile');
    if (!process.env.NEKKO_TEST_REVISION) {
      const assert = require('node:assert/strict');
      assert.equal(report.facts.boundary, 'none');
      for (const side of ['left', 'right']) {
        assert.equal(report.facts[side + '-rest'].opacity, '0');
        assert.equal(report.facts[side + '-hover'].opacity, '1');
        assert.equal(report.facts[side + '-hover'].hit, true);
        assert.equal(report.facts[side + '-keyboard'].opacity, '1');
        assert.notEqual(report.facts[side + '-keyboard'].value, report.facts[side + '-rest'].value);
        assert.notEqual(report.facts[side + '-drag'].value, report.facts[side + '-keyboard'].value);
        assert.ok(Number(report.facts[side + '-drag'].opacity) > 0.95);
        assert.equal(report.facts[side + '-leave'].opacity, '0');
      }
      assert.equal(report.facts['left-closed'], true);
      assert.equal(report.facts['right-closed'], true);
      assert.equal(report.facts.mobile.width, report.facts.mobile.scrollWidth);
    }
    report.facts.visible = win.isVisible();
    report.facts.bounds = win.getBounds();
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'edge-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.NEKKO_EVIDENCE_HOLD) { win.setContentSize(1400, 820); await sleep(Number(process.env.NEKKO_EVIDENCE_HOLD)); }
  app.exit(report.errors.length ? 1 : 0);
});
