// Full-App journey for the design canvas: a design with three versions (the newest animated, in CSS and
// in a requestAnimationFrame loop) and a still one, shown live on Library's tiles and opened from Library,
// served by the real preview server (@nekko-agent/profile/html-preview). A chat also names a fourth
// version that was never written, which Library must leave out. Synthetic bridge, isolated profile, hidden, off-screen,
// non-focusable window; every request off this machine is cancelled and recorded.
// Launch: NEKKO_LAYOUT_SANDBOX=design-canvas-sandbox.cjs NEKKO_LAYOUT_FRAME_SRC=web node layout-evidence-integration.cjs
// NEKKO_DESIGN_BASELINE=1 (with NEKKO_TEST_SOURCE=<unchanged checkout>) captures the same designs in the old file pane.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const writeGif = require('./evidence-gif.cjs');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_DESIGN_BASELINE === '1';
const repo = path.resolve(__dirname, '../../..');
// U+2028/2029 are legal in string literals since ES2019, so only HTML-sensitive characters are escaped.
const js = (v) => JSON.stringify(v).replace(/[<>/]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [], offMachine: [], served: [] };

const frameBox = (name, tint, body = '') => `<section class="frame"><h2>${name}</h2><div class="screen" style="background:${tint}">${body}</div></section>`;
const page = (title, width, frames, extra = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#f3f1f7;color:#1b1b22}
h1{margin:0;padding:32px 40px 8px;font-size:28px}
.canvas{display:flex;gap:40px;padding:24px 40px 48px;width:${width}px;box-sizing:border-box}
.frame{flex:0 0 360px}.frame h2{font-size:14px;font-weight:600;margin:0 0 8px;color:#55556a}
.screen{height:640px;border-radius:28px;box-shadow:0 8px 30px rgba(20,20,40,.12);display:grid;place-items:center;font-size:20px}
.spin{width:64px;height:64px;border-radius:50%;border:6px solid #d9c2d0;border-top-color:#854f6c;animation:spin 1.2s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><h1>${title}</h1><div class="canvas">${frames}</div>${extra}</body></html>`;
const DESIGNS = {
  'checkout-design.html': page('Checkout, first pass', 1280, [frameBox('Cart', '#fff'), frameBox('Payment', '#fff'), frameBox('Done', '#fff')].join('')),
  'checkout-design-v2.html': page('Checkout, second pass', 1280, [frameBox('Cart', '#fdf6fa'), frameBox('Payment', '#fdf6fa'), frameBox('Done', '#fdf6fa')].join('')),
  // The newest: a wide canvas of seven frames, a spinner in CSS and a counter driven by requestAnimationFrame.
  'checkout-design-v3.html': page('Checkout, with the paying state', 2880, [frameBox('Cart', '#fff'), frameBox('Address', '#fff'), frameBox('Payment', '#fff'), frameBox('Paying', '#fdf6fa', '<div class="spin"></div>'), frameBox('Done', '#f1faf3', '<span id="ticks">0</span>'), frameBox('Declined', '#fdf1ef'), frameBox('Empty cart', '#fff')].join(''),
    '<script>let n=0;const t=document.getElementById("ticks");const loop=()=>{t.textContent=String(++n);requestAnimationFrame(loop)};requestAnimationFrame(loop);document.addEventListener("click",()=>{document.body.dataset.clicked="yes"})</script>'),
  'login.html': page('Login', 1280, [frameBox('Sign in', '#fff'), frameBox('Wrong password', '#fdf1ef')].join('')),
};

app.whenReady().then(async () => {
  const folder = path.join(out, 'proj', 'nekko-designs');
  fs.rmSync(path.join(out, 'proj'), { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  for (const [name, html] of Object.entries(DESIGNS)) fs.writeFileSync(path.join(folder, name), html);
  const project = path.join(out, 'proj').replaceAll('\\', '/');
  const file = name => `${project}/nekko-designs/${name}`;
  const { createHtmlPreviewServer } = await import(pathToFileURL(path.join(repo, 'packages/profile/dist/html-preview.js')).href);
  const server = createHtmlPreviewServer({ host: '127.0.0.1' });
  // Each design served twice: for the canvas (with the viewer's script) and for the file pane (without).
  const urls = {};
  let origin = '';
  for (const name of Object.keys(DESIGNS)) for (const controls of [true, false]) {
    const s = await server.serve(path.join(folder, name), { internet: false, controls });
    origin = `http://127.0.0.1:${s.port}/`;
    urls[`${file(name)}|${controls}`] = { id: s.id, url: origin.slice(0, -1) + s.path };
  }
  session.defaultSession.webRequest.onBeforeRequest((d, done) => {
    const ok = /^(file:|data:|blob:|devtools:|about:)/.test(d.url) || d.url.startsWith(origin);
    if (!ok) report.offMachine.push(d.url);
    done({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = source => win.webContents.executeJavaScript(source);
  const check = async (source, label) => { if (baseline) return; const ok = await run(source); report.checks[label] = ok; if (!ok) throw Error(label); };
  const grab = async () => (await win.capturePage(undefined, { stayHidden: true })).toPNG();
  const shot = async name => { const f = path.join(out, `${name}.png`); fs.writeFileSync(f, await grab()); report.captures.push(f); };
  const served = () => win.webContents.mainFrame.framesInSubtree.find(f => f.url.startsWith(origin));
  const inDesign = async source => { const f = served(); return f ? f.executeJavaScript(source) : 'no served frame'; };
  const expectDesign = async (source, label, expected) => { if (baseline) return; const got = await inDesign(source); const ok = got === expected; report.checks[label] = ok ? true : got; if (!ok) throw Error(`${label}: ${got}`); };
  const row = title => `[...document.querySelectorAll('[data-artifact-row]')].find(r => r.querySelector('span span').textContent === ${js(title)})`;
  const click = selector => run(`document.querySelector(${js(selector)}).click()`);
  const zoom = `Number(document.querySelector('[data-design-zoom]').textContent.replace('%', ''))`;
  const frameStyle = `document.querySelector('[data-design-canvas] iframe').style`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(500);
    const listing = Object.keys(DESIGNS).map(name => ({ name, path: file(name), dir: false }));
    await run(`(() => {
      document.querySelector('.zones-intro button[aria-label="Close"]')?.click();
      localStorage.setItem('nekko.libraryIntroSeen', '1');
      localStorage.removeItem('nekko.libraryLayout'); localStorage.removeItem('nekko.libraryCollapsed');
      const f = layoutFixture, urls = ${js(urls)}, sources = ${js(Object.fromEntries(Object.entries(DESIGNS).map(([n, h]) => [file(n), h])))};
      f.records.forEach(r => { r.messages = []; f.putCachedSession(r); });
      // A chat that names a version it never wrote, and a report, so Designs has another kind to lead.
      const now = Date.now(), chat = f.records[0];
      chat.messages = [
        { id: 'gq', role: 'user', content: 'Try another checkout', createdAt: now - 2000 },
        { id: 'ga', role: 'assistant', content: '[Checkout v4](' + ${js(file('checkout-design-v4.html'))} + ') and [Notes](' + ${js(project + '/reports/notes.md')} + ')', createdAt: now - 1000 },
      ];
      chat.updatedAt = now; f.putCachedSession(chat);
      f.asked = [];
      f.bridge.listDir = async (p) => (p === ${js(project + '/nekko-designs')} ? ${js(listing)} : p === ${js(project + '/reports')} ? [{ name: 'notes.md', path: ${js(project + '/reports/notes.md')}, dir: false }] : []);
      f.bridge.listComments = async () => [];
      f.bridge.readFile = async (p) => ({ content: sources[p] ?? '', truncated: false, binary: false });
      f.bridge.openPath = async p => { f.lastOpenPath = p; };
      f.bridge.serveHtmlPreview = async (p, o) => { f.asked.push({ p, internet: o.internet === true, controls: o.controls === true }); return urls[p + '|' + (o.controls === true)]; };
      f.bridge.releaseHtmlPreview = async () => {};
      f.store.setState({ settings: { ...f.store.getState().settings, theme: 'dark', workProfile: 'designer', workspaces: [{ id: 'w1', name: 'Shop', path: ${js(project)}, addedAt: 1 }] } }); f.store.getState().applyTheme();
      f.store.getState().refreshSessions();
      f.store.getState().setView('artifacts');
    })()`);
    await sleep(1200);
    win.setContentSize(1440, 900); await sleep(2600);
    await shot('library');
    await check(`document.querySelectorAll('[data-artifact-row]').length === 3 && ${row('Checkout design')}.textContent.includes('3 versions') && !${row('Login')}.textContent.includes('versions')`, 'versions-are-one-design-and-the-unwritten-one-is-left-out');
    await check(`document.querySelector('[data-library-group]').dataset.libraryGroup === 'design' && document.querySelector('[data-artifact-kind]').dataset.artifactKind === 'design'`, 'designs-lead');
    if (!baseline) {
      await check(`document.querySelectorAll('[data-library-group="design"] [data-live-preview="page"] iframe[data-ready]').length === 2`, 'design-tiles-show-the-pages-themselves');
      await check(`[...document.querySelectorAll('[data-library-group="design"] iframe')].every(f => f.getAttribute('sandbox') === 'allow-scripts allow-forms allow-modals' && getComputedStyle(f).pointerEvents === 'none' && f.tabIndex === -1)`, 'tile-pages-are-sandboxed-and-inert');
      const tileFrames = win.webContents.mainFrame.framesInSubtree.filter(f => f.url.startsWith(origin));
      const held = await Promise.all(tileFrames.map(f => f.executeJavaScript(`document.getAnimations().every(a => a.playState !== 'running')`)));
      report.checks['tiles-hold-their-motion'] = tileFrames.length === 2 && held.every(Boolean);
      if (!report.checks['tiles-hold-their-motion']) throw Error('tiles-hold-their-motion');
    }

    // The newest version opens on the canvas, whole and fitted.
    await run(`(${baseline ? `document.querySelector('[data-artifact-row]')` : row('Checkout design')}).click()`); await sleep(2600);
    await shot('design-open');
    await check(`!!document.querySelector('[data-design-canvas] iframe') && document.querySelector('[data-design-canvas] iframe').src === ${js(urls[`${file('checkout-design-v3.html')}|true`].url)}`, 'opens-the-newest-version-on-the-canvas');
    await check(`JSON.stringify(layoutFixture.asked.at(-1)) === ${js(JSON.stringify({ p: file('checkout-design-v3.html'), internet: false, controls: true }))}`, 'served-offline-with-the-viewer-script');
    await check(`${frameStyle}.width === '2880px' && parseInt(${frameStyle}.height) >= 800 && ${zoom} > 20 && ${zoom} < 60`, 'whole-design-laid-out-and-fitted');
    await check(`document.querySelector('[data-design-canvas] iframe').getAttribute('sandbox') === 'allow-scripts allow-forms allow-modals' && ${frameStyle}.pointerEvents === 'auto' && !document.querySelector('[data-design-interact]')`, 'sandboxed-and-clickable-from-the-start');
    await check(`[...document.querySelectorAll('[role="radiogroup"][aria-label="Version"] [role="radio"]')].map(r => r.textContent.trim() + (r.getAttribute('aria-checked') === 'true' ? '*' : '')).join(' ') === 'v1 v2 v3*'`, 'version-switcher-lists-all-three');

    // It is moving, so Play/Pause is offered, and pausing holds both the CSS animation and the frame loop.
    await check(`document.querySelector('[data-design-playback]')?.textContent.trim() === 'Pause'`, 'pause-offered-for-a-moving-design');
    const ticks = () => inDesign(`Number(document.getElementById('ticks').textContent)`);
    if (!baseline) {
      const frames = [];
      for (let i = 0; i < 8; i++) { frames.push(await grab()); await sleep(90); }
      await click('[data-design-playback]'); await sleep(500);
      await expectDesign(`document.getAnimations()[0].playState`, 'pause-holds-the-css-animation', 'paused');
      const held = await ticks(); await sleep(500);
      report.checks['pause-holds-the-frame-loop'] = (await ticks()) === held;
      if (!report.checks['pause-holds-the-frame-loop']) throw Error('pause-holds-the-frame-loop');
      await check(`document.querySelector('[data-design-playback]').textContent.trim() === 'Play'`, 'button-turns-to-play');
      await shot('design-paused');
      for (let i = 0; i < 6; i++) { frames.push(await grab()); await sleep(90); }
      await click('[data-design-playback]'); await sleep(500);
      await expectDesign(`document.getAnimations()[0].playState`, 'play-resumes-the-css-animation', 'running');
      report.checks['play-resumes-the-frame-loop'] = (await ticks()) > held;
      if (!report.checks['play-resumes-the-frame-loop']) throw Error('play-resumes-the-frame-loop');
      for (let i = 0; i < 8; i++) { frames.push(await grab()); await sleep(90); }
      const gif = path.join(out, 'design-pause-play.gif'); writeGif(gif, frames, 10); report.captures.push(gif);

      // Zoom, move and fit.
      const fitted = await run(zoom);
      await click('[aria-label="Zoom in"]'); await sleep(200);
      await check(`${zoom} > ${fitted}`, 'zoom-in-enlarges');
      const before = await run(`${frameStyle}.transform`);
      await run(`document.querySelector('[data-design-canvas]').dispatchEvent(new WheelEvent('wheel', { deltaX: 300, deltaY: 40, bubbles: true, cancelable: true }))`); await sleep(200);
      await check(`${frameStyle}.transform !== ${js(before)} && ${zoom} > ${fitted}`, 'scroll-moves-the-canvas');
      await run(`document.querySelector('[data-design-canvas]').dispatchEvent(new WheelEvent('wheel', { deltaY: -400, ctrlKey: true, clientX: 900, clientY: 500, bubbles: true, cancelable: true }))`); await sleep(200);
      await check(`${zoom} > ${fitted} * 1.5`, 'pinch-zooms-at-the-pointer');
      await shot('design-zoomed');
      await click('[data-design-zoom]'); await sleep(200);
      await check(`${zoom} === ${fitted}`, 'fit-returns-the-whole-design');

      // The design takes the pointer at once; the space around it still drags the canvas. A hidden window
      // paints nothing, so the browser has no hit-test data for the design's own process and routes real
      // input to the page around it: the click is checked as a hit test on both sides instead.
      const box = await run(`(() => { const f = document.querySelector('[data-design-canvas] iframe'), r = f.getBoundingClientRect(), c = document.querySelector('[data-design-canvas]').getBoundingClientRect(), z = r.width / f.offsetWidth; return { x: Math.round(r.left + 120 * z), y: Math.round(r.top + 200 * z), px: 120, py: 200, bx: Math.round(c.left + c.width / 2), by: Math.round(c.bottom - 30) }; })()`);
      await check(`(() => { const e = document.elementFromPoint(${box.x}, ${box.y}); return e?.tagName === 'IFRAME' && getComputedStyle(e).pointerEvents === 'auto'; })()`, 'the-design-is-under-the-pointer-and-takes-it');
      await expectDesign(`document.elementFromPoint(${box.px}, ${box.py})?.closest('.frame') ? 'frame' : 'none'`, 'the-design-has-its-screen-at-that-point', 'frame');
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
      const cdp = (type, x, y) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
      const resting = await run(`${frameStyle}.transform`);
      await cdp('mouseMoved', box.bx, box.by); await cdp('mousePressed', box.bx, box.by);
      for (let i = 1; i <= 6; i++) { await cdp('mouseMoved', box.bx - i * 20, box.by - i * 5); await sleep(30); }
      await cdp('mouseReleased', box.bx - 120, box.by - 30); await sleep(200);
      await check(`${frameStyle}.transform !== ${js(resting)}`, 'dragging-the-space-around-moves-the-canvas');

      // A scroll over the design moves the canvas; the page passes it up.
      const beforeWheel = await run(`${frameStyle}.transform`);
      await inDesign(`document.body.dispatchEvent(new WheelEvent('wheel', { deltaX: 160, deltaY: 0, clientX: 200, clientY: 200, bubbles: true, cancelable: true }))`); await sleep(200);
      await check(`${frameStyle}.transform !== ${js(beforeWheel)}`, 'scrolling-over-the-design-moves-the-canvas');

      // Space held in the design turns it into a handle; letting go hands the pointer back.
      await inDesign(`document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }))`); await sleep(150);
      await check(`${frameStyle}.pointerEvents === 'none' && document.querySelector('[data-design-canvas]').hasAttribute('data-design-hand')`, 'space-in-the-design-drags-the-canvas');
      await inDesign(`document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }))`); await sleep(150);
      await check(`${frameStyle}.pointerEvents === 'auto' && !document.querySelector('[data-design-canvas]').hasAttribute('data-design-hand')`, 'letting-go-of-space-hands-back-the-pointer');
      await click('[data-design-zoom]'); await sleep(200);

      // An older version, which is still: no Play/Pause.
      await run(`[...document.querySelectorAll('[role="radiogroup"][aria-label="Version"] [role="radio"]')][0].click()`); await sleep(2400);
      await check(`document.querySelector('[data-design-canvas] iframe').src === ${js(urls[`${file('checkout-design.html')}|true`].url)} && !document.querySelector('[data-design-playback]')`, 'older-version-opens-without-playback');
      await check(`document.querySelector('[data-library-back]').parentElement.textContent.includes('checkout-design.html') && ${frameStyle}.width === '1440px'`, 'header-names-the-version-open');
      await shot('design-v1');

      // Source shows the file itself, and Canvas comes back.
      await click('[data-design-source]'); await sleep(1500);
      await check(`!document.querySelector('[data-design-canvas]') && !!document.querySelector('[data-served-preview]') && !!document.querySelector('[data-design-back]')`, 'source-opens-the-file-pane');
      await check(`JSON.stringify(layoutFixture.asked.at(-1)) === ${js(JSON.stringify({ p: file('checkout-design.html'), internet: false, controls: false }))}`, 'file-pane-page-has-no-viewer-script');
      await check(`!!document.querySelector('[data-file-read-only]') && !document.querySelector('[data-preview-edit]') && !document.querySelector('[aria-label="Undo (Ctrl+Z)"]')`, 'a-design-opens-view-only');
      await shot('design-source');
      await click('[data-design-back]'); await sleep(1500);
      await check(`!!document.querySelector('[data-design-canvas] iframe')`, 'canvas-comes-back');

      // A still design.
      await run(`${row('Login')}.click()`); await sleep(3600);
      await check(`!!document.querySelector('[data-design-canvas] iframe') && !document.querySelector('[data-design-playback]') && !document.querySelector('[role="radiogroup"][aria-label="Version"]')`, 'still-design-has-no-playback-or-versions');
      await shot('design-still');

      win.setContentSize(430, 932); await sleep(600);
      await check(`!!document.querySelector('[data-design-canvas] iframe') && ${zoom} < 40 && document.querySelector('[data-design-controls]').getBoundingClientRect().right <= 431`, 'narrow-window-fits-the-design');
      await shot('design-narrow');
    }
    report.served = await run('layoutFixture.asked');
    if (report.offMachine.length) throw Error('Requests left this machine: ' + report.offMachine.join(', '));
    if (report.errors.length) throw Error('Renderer errors: ' + report.errors.join('; '));
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focusable) throw Error('Unsafe fixture window');
  } catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await server.close(); win.destroy(); app.exit(process.exitCode || 0); }
});
