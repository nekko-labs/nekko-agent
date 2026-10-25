const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { GifWriter } = require('omggif');
const out = process.env.NEKKO_COMPONENT_OUT;
if (!out) throw Error('Launch through tool-timing-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], captures: [], errors: [] };
// Derive the GIF palette from the frames, preserving the UI's pale tints.
function gif(frames) {
  const colors = new Map();
  const key = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const rgb = k => [((k >> 10) & 31) * 8, ((k >> 5) & 31) * 8, (k & 31) * 8];
  for (const f of frames) for (let i = 0; i < f.data.length; i += 4) { const k = key(f.data[i], f.data[i + 1], f.data[i + 2]); colors.set(k, (colors.get(k) || 0) + 1); }
  const palette = [...colors].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => { const [r, g, b] = rgb(k); return (r << 16) | (g << 8) | b; });
  while (palette.length < 256) palette.push(0);
  const nearest = new Map();
  for (const k of colors.keys()) {
    const [r, g, b] = rgb(k); let best = 0, distance = Infinity;
    palette.forEach((c, i) => { const d = (r - (c >> 16)) ** 2 + (g - ((c >> 8) & 255)) ** 2 + (b - (c & 255)) ** 2; if (d < distance) { best = i; distance = d; } });
    nearest.set(k, best);
  }
  const { width, height } = frames[0];
  const buffer = Buffer.alloc(width * height * frames.length * 2);
  const writer = new GifWriter(buffer, width, height, { palette, loop: 0 });
  for (const f of frames) {
    const pixels = new Uint8Array(width * height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = nearest.get(key(f.data[i * 4], f.data[i * 4 + 1], f.data[i * 4 + 2]));
    writer.addFrame(0, 0, width, height, pixels, { delay: 20 });
  }
  fs.writeFileSync(path.join(out, 'tool-timing.gif'), buffer.subarray(0, writer.end()));
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 820, height: 400, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'Tool timing, isolated evidence', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const frames = [];
  const image = async () => (await win.capturePage(undefined, { stayHidden: true })).resize({ width: 820 }).toPNG();
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(600);
    const first = await run("Array.from(document.querySelectorAll('[data-tool-elapsed]')).map(e => e.textContent)");
    for (const phase of [0, 1, 2, 3]) {
      // Literal expressions only; no data is spliced into executable code.
      await run(['timingFixture.phase(0)', 'timingFixture.phase(1)', 'timingFixture.phase(2)', 'timingFixture.phase(3)'][phase]);
      await sleep(150);
      for (let i = 0; i < 7; i++) {
        await run('timingFixture.tick()'); await sleep(200);
        frames.push(PNG.sync.read(await image()));
      }
      const file = path.join(out, ['parallel-running.png', 'model-wait.png', 'public-thinking.png', 'completed.png'][phase]);
      fs.writeFileSync(file, await image()); report.captures.push(file);
      report.checks.push(await run(`({ timers: Array.from(document.querySelectorAll('[data-tool-elapsed]')).map(e => ({ text: e.textContent, running: e.hasAttribute('data-running') })), model: !!document.querySelector('[data-model-activity]'), publicText: document.querySelector('[data-public-reasoning]')?.textContent || '' })`));
    }
    report.initialTimers = first; report.bounds = win.getBounds(); report.hidden = !win.isVisible(); report.focused = win.isFocused();
    if (!process.env.NEKKO_TEST_SOURCE) {
      const [parallel, wait, thinking, completed] = report.checks;
      if (!parallel.timers.some(t => t.running && t.text !== '1.0s') || parallel.timers.at(-1).running) throw Error('Parallel timers incorrect');
      if (!wait.model || wait.timers.some(t => t.running)) throw Error('Model wait not distinct from tool execution');
      if (!thinking.publicText.includes('same settings store') || completed.model) throw Error('Public thinking/completion incorrect');
    }
    if (!report.hidden || report.focused || report.errors.length) throw Error('Isolation or console failure');
    gif(frames); report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
