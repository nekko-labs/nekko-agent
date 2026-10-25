const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_COMPONENT_OUT;
if (!out) throw Error('Launch through work-progress-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const report = { checks: [], errors: [], captures: [], windows: [], visuallyInspected: false, baseline: process.env.NEKKO_TEST_REVISION || null };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// JSON literals, including HTML-sensitive characters, never raw source interpolation.
const js = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function gif(frames, file) {
  const modules = process.env.NEKKO_TEST_MODULES;
  const { PNG } = require(path.join(modules, 'pngjs'));
  const { GifWriter } = require(path.join(modules, 'omggif'));
  const decoded = frames.map(frame => PNG.sync.read(frame));
  const colors = new Map();
  for (const { data } of decoded) for (let i = 0; i < data.length; i += 4) { const c = ((data[i] >> 3) << 19) | ((data[i + 1] >> 3) << 11) | ((data[i + 2] >> 3) << 3); colors.set(c, (colors.get(c) || 0) + 1); }
  const palette = [...colors].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([c]) => c);
  while (palette.length < 256) palette.push(0);
  const cache = new Map();
  const buffer = Buffer.alloc(decoded[0].width * decoded[0].height * frames.length * 2 + 100000);
  const writer = new GifWriter(buffer, decoded[0].width, decoded[0].height, { loop: 0, palette });
  for (const frame of decoded) {
    const pixels = new Uint8Array(frame.width * frame.height);
    for (let i = 0; i < pixels.length; i++) {
      const r = frame.data[i * 4], g = frame.data[i * 4 + 1], b = frame.data[i * 4 + 2], key = (r << 16) | (g << 8) | b;
      if (!cache.has(key)) { let best = 0, distance = Infinity; palette.forEach((c, index) => { const d = (r - (c >> 16)) ** 2 + (g - ((c >> 8) & 255)) ** 2 + (b - (c & 255)) ** 2; if (d < distance) { distance = d; best = index; } }); cache.set(key, best); }
      pixels[i] = cache.get(key);
    }
    writer.addFrame(0, 0, frame.width, frame.height, pixels, { delay: 35 });
  }
  fs.writeFileSync(file, buffer.subarray(0, writer.end()));
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:|blob:)/.test(details.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 900, height: 760, useContentSize: true, x: -10000, y: -10000, show: false, focusable: false, skipTaskbar: true, title: 'Work progress isolated renderer', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window focused'));
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  const run = code => win.webContents.executeJavaScript(code, true);
  const assert = (ok, label) => { if (!ok) throw Error(label); report.checks.push(label); };
  const capture = async name => { const file = path.join(out, name + '.png'); const png = (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG(); fs.writeFileSync(file, png); report.captures.push(file); return png; };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(700);
    assert(await run('!!document.querySelector("[data-pr-actions]")'), 'real PR card mounted');
    const current = !process.env.NEKKO_TEST_REVISION;
    for (const width of [900, 390]) {
      win.setContentSize(width, 760);
      await run('window.__update(false)'); await sleep(300);
      await run('document.querySelectorAll("[data-pr-progress] details").forEach(element => { element.open = false; })');
      await capture(`${width}-active`);
      if (current) {
        assert(await run('document.body.textContent.includes("0 of 2 passed") && document.body.textContent.includes("2 pending")'), `${width}: active verification and CI counts`);
        await run('document.querySelector("[data-verification-checklist] summary").click()');
        assert(await run('!document.querySelector("[data-verification-checklist]").open'), `${width}: verification details collapse`);
        await run('document.querySelector("[data-verification-checklist] summary").click()');
        await run('document.querySelector("[data-pr-progress] details summary").click()');
        assert(await run('document.querySelector("[data-pr-progress] details").open'), `${width}: check details expand`);
        for (const [text, destination] of [['CI checks', 'https://github.com/example/fixture/pull/42/checks'], ['Review threads', 'https://github.com/example/fixture/pull/42/files'], ['Evidence', 'https://example.test/evidence/desktop'], ['Renderer integration', 'https://example.test/check/renderer']]) {
          await run(`(() => { const link = [...document.querySelectorAll('a')].find(a => a.textContent === ${js(text)}); if (!link || link.href !== ${js(destination)}) throw Error('Incorrect destination'); link.click(); })()`);
          assert(await run(`window.__opened.at(-1) === ${js(destination)}`), `${width}: ${text} opens stub destination`);
        }
      }
      const frames = [];
      if (current) for (let i = 0; i < 3; i++) { frames.push((await win.capturePage(undefined, { stayHidden: true })).toPNG()); await sleep(200); }
      await run('window.__update(true)'); await sleep(300);
      await capture(`${width}-updated`);
      if (current) {
        assert(await run('document.body.textContent.includes("1 of 2 passed") && document.body.textContent.includes("1 blocked") && document.body.textContent.includes("Stale") && document.body.textContent.includes("3 of 3 finished") && document.body.textContent.includes("3 resolved · 1 unresolved")'), `${width}: passed blocked stale CI and thread updates`);
        for (let i = 0; i < 4; i++) { frames.push((await win.capturePage(undefined, { stayHidden: true })).toPNG()); await sleep(200); }
        try { const file = path.join(out, `${width}-updates.gif`); gif(frames, file); report.captures.push(file); } catch (error) { report.gifLimitation = String(error); }
      }
      if (current) {
        const layout = await run(`(() => {
          const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width }; };
          return { card: rect('[data-pr-actions]'), content: rect('.pr-action-content'), progress: rect('[data-pr-progress]'), actions: rect('[data-pr-action-controls]') };
        })()`);
        if (width === 390) {
          assert(layout.progress.width >= layout.card.width - 24, '390: CI/review content uses full card width');
          assert(layout.actions.y >= layout.content.bottom, '390: actions occupy a separate wrapping row');
        } else {
          assert(layout.actions.x >= layout.content.right, '900: desktop actions remain beside content');
        }
        report.checks.push(`${width}: layout geometry ${JSON.stringify(layout)}`);
        const terminal = await run(`document.querySelector('[aria-label="Verification checklist"] > div').textContent`);
        assert(!terminal.includes('Stale'), `${width}: passed report retains age without stale label`);
      }
      const overflow = await run('({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth })');
      assert(overflow.document <= width && overflow.body <= width, `${width}: no document horizontal overflow ${JSON.stringify(overflow)}`);
      report.windows.push({ width, visible: win.isVisible(), focused: win.isFocused(), focusable: win.isFocusable(), bounds: win.getBounds(), contentBounds: win.getContentBounds() });
      assert(!win.isVisible() && !win.isFocused() && !win.isFocusable(), `${width}: hidden nonfocusable invariant`);
    }
  } catch (error) { report.errors.push(String(error)); }
  finally { report.success = !report.errors.length; fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
