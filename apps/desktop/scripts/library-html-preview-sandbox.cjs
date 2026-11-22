// Full-App journey: a design opened from Library runs with its own folder, served by the real
// preview server (@nekko-agent/profile/html-preview). Synthetic bridge, isolated profile, hidden,
// off-screen, non-focusable window; every request off this machine is cancelled and recorded.
// Launch: NEKKO_LAYOUT_SANDBOX=library-html-preview-sandbox.cjs NEKKO_LAYOUT_FRAME_SRC=web node layout-evidence-integration.cjs
// NEKKO_LIBRARY_BASELINE=1 (with NEKKO_TEST_SOURCE=<old checkout>) captures the old scriptless preview.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_LIBRARY_BASELINE === '1';
const repo = path.resolve(__dirname, '../../..');
// U+2028/2029 are legal in string literals since ES2019, so only HTML-sensitive characters are escaped.
const js = (v) => JSON.stringify(v).replace(/[<>/]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [], offMachine: [] };

// A design the way agents write them: its own stylesheet, scripts and pictures beside it.
function writeDesign(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pricing</title>
<link rel="stylesheet" href="assets/style.css"></head>
<body><main>
  <img class="hero" src="assets/hero.svg" alt="">
  <h1>Simple pricing</h1>
  <p id="status">Scripts did not run</p>
  <p id="module">Module did not load</p>
  <p id="saved">Storage did not work</p>
  <section class="plans"><article><h2>Solo</h2><b>$0</b></article><article class="pick"><h2>Team</h2><b>$12</b></article><article><h2>Studio</h2><b>$40</b></article></section>
  <img class="remote" src="https://images.example.com/remote.png" alt="">
</main>
<script src="assets/app.js"></script>
<script type="module">import { label } from './assets/mod.js'; document.getElementById('module').textContent = label;</script>
</body></html>`);
  fs.writeFileSync(path.join(dir, 'assets', 'style.css'), `body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#0f1020;color:#e8e6f5}
main{max-width:760px;margin:0 auto;padding:40px 24px}
h1{color:rgb(255, 122, 89);font-size:40px;margin:16px 0 8px}
.hero{width:100%;height:140px;display:block;border-radius:16px}
.plans{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:24px}
.plans article{background:#1b1c33;border-radius:14px;padding:16px}
.plans .pick{outline:2px solid rgb(255, 122, 89)}
.plans b{font-size:28px}
#status,#module,#saved{margin:2px 0;color:#9fa3c9}`);
  fs.writeFileSync(path.join(dir, 'assets', 'hero.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 140"><defs><linearGradient id="g" x2="1"><stop offset="0" stop-color="#ff7a59"/><stop offset="1" stop-color="#7b61ff"/></linearGradient></defs><rect width="760" height="140" fill="url(#g)"/></svg>');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), "document.getElementById('status').textContent = 'Scripts ran';\nlocalStorage.setItem('plan', 'remembered');\ndocument.getElementById('saved').textContent = localStorage.getItem('plan');\n");
  fs.writeFileSync(path.join(dir, 'assets', 'mod.js'), "export const label = 'Module loaded';\n");
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=never-served\n');
}

app.whenReady().then(async () => {
  // A folder name that keeps the page a Web page: a design opens on the design canvas instead of this pane.
  const design = path.join(out, 'pricing-page');
  writeDesign(design);
  const page = path.join(design, 'index.html');
  const { createHtmlPreviewServer } = await import(pathToFileURL(path.join(repo, 'packages/profile/dist/html-preview.js')).href);
  const server = createHtmlPreviewServer({ host: '127.0.0.1' });
  const local = await server.serve(page, { internet: false });
  const online = await server.serve(page, { internet: true });
  const editing = await server.serve(page, { internet: false, edit: true });
  const original = fs.readFileSync(page, 'utf8');
  const origin = `http://127.0.0.1:${local.port}/`;
  const urls = { local: origin.slice(0, -1) + local.path, online: origin.slice(0, -1) + online.path, edit: origin.slice(0, -1) + editing.path };
  session.defaultSession.webRequest.onBeforeRequest((d, done) => {
    const ok = /^(file:|data:|blob:|devtools:)/.test(d.url) || d.url.startsWith(origin);
    if (!ok) report.offMachine.push(d.url);
    done({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = source => win.webContents.executeJavaScript(source);
  const check = async (source, label) => { const ok = await run(source); report.checks[label] = ok; if (!ok) throw Error(label); };
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const frame = () => win.webContents.mainFrame.framesInSubtree.find(f => f.url.startsWith(origin));
  const inFrame = async (source, label, expected) => {
    const f = frame();
    const got = f ? await f.executeJavaScript(source) : 'no served frame';
    const ok = got === expected; report.checks[label] = ok ? true : got;
    if (!ok) throw Error(`${label}: ${got}`);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(500);
    const fileUrl = pathToFileURL(page).href;
    await run(`(() => {
      document.querySelector('.zones-intro button[aria-label="Close"]')?.click();
      localStorage.setItem('nekko.libraryIntroSeen', '1');
      localStorage.setItem('nekko.libraryLayout', 'list');
      const f = layoutFixture, now = Date.now(), s = f.records[0];
      s.messages = [{ id: 'q', role: 'user', content: 'Design a pricing page', createdAt: now - 1000 }, { id: 'r', role: 'assistant', content: 'Here it is: [Pricing page](' + ${js(fileUrl)} + ')', createdAt: now }];
      s.updatedAt = now; f.putCachedSession(s);
      f.records.slice(1).forEach(r => { r.messages = []; f.putCachedSession(r); });
      f.bridge.listComments = async () => [];
      f.bridge.readFile = async () => ({ content: ${js(fs.readFileSync(page, 'utf8'))}, truncated: false, binary: false });
      f.served = [];
      f.released = [];
      f.written = [];
      // Like the host, a write answers once the file is on disk: here, once the journey has written it.
      f.bridge.writeFile = (p, text) => { f.written.push({ p, text }); return new Promise((done) => { f.landWrite = done; }); };
      f.bridge.serveHtmlPreview = async (p, o) => { f.served.push({ p, internet: o.internet, edit: o.edit === true }); return o.edit ? { id: ${js(editing.id)}, url: ${js(urls.edit)} } : o.internet ? { id: ${js(online.id)}, url: ${js(urls.online)} } : { id: ${js(local.id)}, url: ${js(urls.local)} }; };
      f.bridge.releaseHtmlPreview = async (id) => { f.released.push(id); };
      f.store.setState({ settings: { ...f.store.getState().settings, theme: 'dark' } }); f.store.getState().applyTheme();
      f.store.getState().refreshSessions();
      f.store.getState().setView('artifacts');
    })()`);
    await sleep(1200);
    await run(`document.querySelector('[data-artifact-row]').click()`);
    await sleep(2000);
    await shot(baseline ? 'before-library-design' : 'after-library-design');
    if (!baseline) {
      await check(`document.querySelector('[data-served-preview] iframe')?.getAttribute('src') === ${js(urls.local)}`, 'library-frames-the-served-page');
      await check(`document.querySelector('[data-served-preview] iframe').getAttribute('sandbox') === 'allow-scripts allow-forms allow-modals'`, 'frame-sandbox-has-no-same-origin');
      await check(`layoutFixture.served.length === 1 && layoutFixture.served[0].internet === false`, 'served-with-internet-off');
      await inFrame(`document.getElementById('status').textContent`, 'linked-script-ran', 'Scripts ran');
      await inFrame(`document.getElementById('module').textContent`, 'module-script-loaded', 'Module loaded');
      await inFrame(`document.getElementById('saved').textContent`, 'storage-stand-in-works', 'remembered');
      await inFrame(`getComputedStyle(document.querySelector('h1')).color`, 'linked-stylesheet-applied', 'rgb(255, 122, 89)');
      await inFrame(`document.querySelector('img.hero').naturalWidth > 0`, 'folder-image-loaded', true);
      await inFrame(`document.querySelector('img.remote').naturalWidth`, 'remote-image-blocked', 0);
      await inFrame(`self.origin`, 'page-origin-is-opaque', 'null');
      await inFrame(`(() => { try { return parent.document ? 'reached the app' : 'none'; } catch { return 'blocked'; } })()`, 'app-document-unreachable', 'blocked');
      // A refusal carries no CORS header, so the opaque page can't even read the status.
      await inFrame(`fetch('.env').then(r => r.ok ? 'served' : 'refused', () => 'refused')`, 'secret-file-refused', 'refused');
      await inFrame(`fetch('http://127.0.0.1:9/').then(() => 'reached', () => 'blocked')`, 'other-local-service-blocked', 'blocked');
      if (report.offMachine.length) throw Error('Internet off, yet requests left: ' + report.offMachine.join(', '));
      report.checks['no-request-left-with-internet-off'] = true;

      // Edit text: the page is served again with the editor script; clicking the heading makes it editable,
      // and Enter puts the new text into the file's source, changing nothing else.
      await check(`!!document.querySelector('[data-preview-edit]') && document.querySelector('[data-preview-edit]').getAttribute('aria-pressed') === 'false'`, 'edit-text-offered-for-a-web-page');
      await run(`document.querySelector('[data-preview-edit]').click()`); await sleep(1800);
      await check(`document.querySelector('[data-served-preview] iframe')?.getAttribute('src') === ${js(urls.edit)} && layoutFixture.served.at(-1).edit === true && layoutFixture.served.at(-1).internet === false`, 'edit-text-serves-the-editor-script-offline');
      await inFrame(`(() => { const h = document.querySelector('h1'); h.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return h.hasAttribute('data-nekko-edit-hover'); })()`, 'hovering-text-outlines-it', true);
      await sleep(250); await shot('after-edit-hover');
      await inFrame(`(() => { const h = document.querySelector('h1'); h.click(); return h.getAttribute('contenteditable'); })()`, 'clicking-text-makes-it-editable', 'plaintext-only');
      await inFrame(`(() => { const h = document.querySelector('h1'); h.textContent = 'Fair pricing for teams'; return true; })()`, 'typed-new-text', true);
      await sleep(250); await shot('after-edit-typing');
      await inFrame(`(() => { document.querySelector('h1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`, 'enter-saves', true);
      await sleep(600);
      const written = await run(`layoutFixture.written.map(w => w.text)`);
      report.checks['the-file-gets-only-that-change'] = written.length === 1 && written[0] === original.replace('<h1>Simple pricing</h1>', '<h1>Fair pricing for teams</h1>');
      if (!report.checks['the-file-gets-only-that-change']) throw Error('the-file-gets-only-that-change: ' + JSON.stringify(written).slice(0, 400));
      // The journey writes the file as the host would and answers the write; then the page reloads with the change, still editable.
      await inFrame(`document.querySelector('h1').textContent`, 'page-keeps-the-edit-until-the-save-lands', 'Fair pricing for teams');
      fs.writeFileSync(page, written[0]); await run('layoutFixture.landWrite()'); await sleep(1500);
      await inFrame(`document.querySelector('h1').textContent`, 'page-reloads-with-the-change', 'Fair pricing for teams');
      await inFrame(`(() => { const h = document.querySelector('h1'); h.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return h.hasAttribute('data-nekko-edit-hover'); })()`, 'still-editable-after-the-reload', true);
      await shot('after-edit-saved');
      // Text a script wrote ("Scripts ran") is not in the file: refused with a note, nothing written.
      await inFrame(`(() => { const p = document.getElementById('status'); p.click(); p.textContent = 'Changed'; p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`, 'script-text-edited', true);
      await sleep(600);
      await check(`layoutFixture.written.length === 1 && document.body.innerText.includes('Change it in Source')`, 'script-made-text-is-refused');
      // The change is in the code view too, as an undo step.
      await run(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Source').click()`); await sleep(400);
      await check(`document.querySelector('textarea[aria-label^="Edit "]').value.includes('<h1>Fair pricing for teams</h1>') && !document.querySelector('[aria-label="Undo (Ctrl+Z)"]').disabled`, 'code-view-has-the-change-with-undo');
      await run(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Preview').click()`); await sleep(1500);
      fs.writeFileSync(page, original);
      await run(`document.querySelector('[data-preview-internet]').click()`);
      await sleep(2000);
      await check(`document.querySelector('[data-served-preview] iframe')?.getAttribute('src') === ${js(urls.online)} && document.querySelector('[data-preview-internet]').getAttribute('aria-pressed') === 'true'`, 'internet-toggle-reserves-the-page');
      await check(`layoutFixture.released.includes(${js(local.id)})`, 'previous-page-released');
      await inFrame(`document.getElementById('status').textContent`, 'scripts-still-run-with-internet', 'Scripts ran');
      report.checks['internet-on-lets-https-out'] = report.offMachine.some(u => u.startsWith('https://images.example.com/'));
      if (!report.checks['internet-on-lets-https-out']) throw Error('internet-on-lets-https-out');
      await shot('after-library-design-internet');
      win.setContentSize(430, 932); await sleep(600);
      await shot('after-library-design-narrow');
      await check(`!!document.querySelector('[data-served-preview] iframe')`, 'narrow-shows-the-served-page');
    }
    // The blocked image, the refused .env and the blocked local service are provoked on purpose.
    const ours = report.errors.filter(e => !/images\.example\.com|ERR_BLOCKED_BY_CLIENT|Content Security Policy|\/\.env' from origin 'null'/.test(e));
    // The baseline's errors are the bug itself (blocked stylesheet, images and scripts): recorded, not fatal.
    if (ours.length && !baseline) throw Error('Renderer errors: ' + ours.join('; '));
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focusable) throw Error('Unsafe fixture window');
  } catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await server.close(); win.destroy(); app.exit(process.exitCode || 0); }
});
