// Full-App journey for a design a chat made: its card offers Open in chat (the file pane beside the chat) and
// Open in Library (Library, full screen, on the design canvas), served by the real preview server
// (@nekko-agent/profile/html-preview). The chat names the newest version and an older one of the same design.
// Synthetic bridge, isolated profile, hidden, off-screen, non-focusable window; every request off this machine
// is cancelled and recorded.
// Launch: NEKKO_LAYOUT_SANDBOX=design-open-in-library-sandbox.cjs NEKKO_LAYOUT_FRAME_SRC=web node layout-evidence-integration.cjs
// With NEKKO_TEST_SOURCE=<unchanged checkout> it captures the chat's cards only (the "before").
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
// A fresh profile each run: the last run ends with a file pane open beside the chat, which would mount before the stubs.
fs.rmSync(path.join(out, 'profile'), { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
app.setPath('userData', path.join(out, 'profile'));
const baseline = !!process.env.NEKKO_TEST_SOURCE;
const repo = path.resolve(__dirname, '../../..');
const js = (v) => JSON.stringify(v).replace(/[<>/]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [], offMachine: [] };

const frameBox = (name, tint) => `<section class="frame"><h2>${name}</h2><div class="screen" style="background:${tint}"></div></section>`;
const page = (title, frames) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#f3f1f7;color:#1b1b22}
h1{margin:0;padding:32px 40px 8px;font-size:28px}
.canvas{display:flex;gap:40px;padding:24px 40px 48px;width:1280px;box-sizing:border-box}
.frame{flex:0 0 360px}.frame h2{font-size:14px;font-weight:600;margin:0 0 8px;color:#55556a}
.screen{height:640px;border-radius:28px;box-shadow:0 8px 30px rgba(20,20,40,.12)}
</style></head><body><h1>${title}</h1><div class="canvas">${frames}</div></body></html>`;
const DESIGNS = {
  'checkout-design.html': page('Checkout, first pass', [frameBox('Cart', '#fff'), frameBox('Payment', '#fff'), frameBox('Done', '#fff')].join('')),
  // Its script marks the page when it runs, so the journey can tell a running page from a still picture.
  'checkout-design-v2.html': page('Checkout, second pass', [frameBox('Cart', '#fdf6fa'), frameBox('Payment', '#fdf6fa'), frameBox('Done', '#f1faf3')].join('') + '<script>document.body.dataset.ran = "yes"</script>'),
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
  const check = async (source, label) => { const ok = await run(source); report.checks[label] = ok; if (!ok) throw Error(label); };
  // A hidden offscreen window can hand back a stale frame: ask for a fresh paint first.
  const shot = async name => { win.webContents.invalidate(); await sleep(300); const f = path.join(out, `${name}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const card = title => `[...document.querySelectorAll('[data-render-card]')].find(c => c.getAttribute('aria-label') === ${js(`${title}, HTML page`)})`;
  const press = (title, label) => run(`[...(${card(title)}).querySelectorAll('button')].find(b => b.textContent.trim() === ${js(label)}).click()`);
  const shown = selector => `(() => { const el = document.querySelector(${js(selector)}); return !!el && getComputedStyle(el).display !== 'none'; })()`;
  const versions = `[...document.querySelectorAll('[role="radiogroup"][aria-label="Version"] [role="radio"]')].map(r => r.textContent.trim() + (r.getAttribute('aria-checked') === 'true' ? '*' : '')).join(' ')`;
  const canvasSrc = `document.querySelector('[data-design-canvas] iframe')?.src`;
  const backToChat = async () => { await run(`layoutFixture.store.getState().focusChatOnWall(layoutFixture.records[0].id)`); await sleep(1500); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(500);
    const listing = Object.keys(DESIGNS).map(name => ({ name, path: file(name), dir: false }));
    await run(`(() => {
      document.querySelector('.zones-intro button[aria-label="Close"]')?.click();
      // Library's first-visit guide has not been seen: Open in Library must still land on the design.
      localStorage.removeItem('nekko.libraryIntroSeen');
      localStorage.removeItem('nekko.libraryLayout'); localStorage.removeItem('nekko.libraryCollapsed'); localStorage.removeItem('library:index:v1');
      const f = layoutFixture, sources = ${js(Object.fromEntries(Object.entries(DESIGNS).map(([n, h]) => [file(n), h])))};
      f.records.forEach(r => { r.messages = []; f.putCachedSession(r); });
      const now = Date.now(), chat = f.records[0];
      chat.title = 'Checkout redesign';
      chat.workspaceId = 'w1';
      chat.messages = [
        { id: 'q', role: 'user', content: 'Design the checkout again, and keep the first pass.', createdAt: now - 2000 },
        { id: 'a', role: 'assistant', content: 'The second pass is ready.\\n\\n[Checkout, second pass](' + ${js(file('checkout-design-v2.html'))} + ')\\n\\n[Checkout, first pass](' + ${js(file('checkout-design.html'))} + ')', createdAt: now - 1000 },
      ];
      chat.updatedAt = now; f.putCachedSession(chat);
      f.asked = [];
      f.bridge.listDir = async (p) => (p === ${js(project + '/nekko-designs')} ? ${js(listing)} : []);
      f.bridge.listComments = async () => [];
      f.bridge.readFile = async (p) => ({ content: sources[p] ?? '', truncated: false, binary: false });
      f.bridge.openPath = async p => { f.lastOpenPath = p; };
      f.bridge.serveHtmlPreview = async (p, o) => { f.asked.push({ p, controls: o.controls === true }); return ${js(urls)}[p + '|' + (o.controls === true)]; };
      f.bridge.releaseHtmlPreview = async () => {};
      // The desktop app's preload offers the isolated interactive window; the fixture has none of its own.
      window.nekkoPreview = { open: async () => { f.previewOpened = true; } };
      f.store.setState({ settings: { ...f.store.getState().settings, theme: 'dark', workspaces: [{ id: 'w1', name: 'Shop', path: ${js(project)}, addedAt: 1 }] } }); f.store.getState().applyTheme();
      f.store.getState().refreshSessions();
      f.store.getState().focusChatOnWall(chat.id);
    })()`);
    // The wall's first entrance stalls in a hidden window (no frames to finish it), so leave and come back once,
    // the same on both sides, then let the cards' pages draw before the picture.
    await sleep(1500);
    await run(`layoutFixture.store.getState().setView('artifacts')`); await sleep(600);
    await backToChat();
    await run(`document.querySelector('[data-render-card]')?.scrollIntoView({ block: 'center' })`); await sleep(2500);
    await shot('chat-cards');
    if (baseline) { report.success = true; return; }

    await check(`[${card('Checkout, second pass')}, ${card('Checkout, first pass')}].every(c => c && [...c.querySelectorAll('button')].map(b => b.textContent.trim()).join('|') === 'Open in chat|Open in Library')`, 'a-design-card-offers-chat-and-library-and-no-interactive-button');

    // The card runs the page itself: served offline with its folder, in the served-page sandbox, taking the pointer.
    const liveFrame = `${card('Checkout, second pass')}.querySelector('[data-render-live] iframe')`;
    await check(`!!${liveFrame} && ${liveFrame}.src === ${js(urls[`${file('checkout-design-v2.html')}|false`].url)} && ${liveFrame}.getAttribute('sandbox') === 'allow-scripts allow-forms allow-modals' && getComputedStyle(${liveFrame}).pointerEvents !== 'none' && ${liveFrame}.tabIndex !== -1`, 'card-runs-the-page-live-and-clickable');
    // Library's tiles (visited above) ask with the canvas script; the card's own request is the one without it, and its frame shows that page.
    await check(`layoutFixture.asked.some(a => a.p === ${js(file('checkout-design-v2.html'))} && a.controls === false)`, 'card-page-served-without-the-canvas-script');
    const cardPage = win.webContents.mainFrame.framesInSubtree.find(f => f.url === urls[`${file('checkout-design-v2.html')}|false`].url);
    report.checks['card-page-scripts-run'] = !!cardPage && await cardPage.executeJavaScript('document.body.dataset.ran') === 'yes';
    if (!report.checks['card-page-scripts-run']) throw Error('card-page-scripts-run');

    // Open in Library: Library, the design on its canvas, filling the page. The guide waits for a visit of its own.
    await press('Checkout, second pass', 'Open in Library'); await sleep(2800);
    await shot('library-full-screen');
    await check(`!!document.querySelector('[data-artifacts-view]') && layoutFixture.store.getState().view === 'artifacts'`, 'goes-to-library');
    await check(`!document.querySelector('[role="dialog"][aria-modal="true"]')`, 'first-visit-guide-does-not-cover-it');
    await check(`${canvasSrc} === ${js(urls[`${file('checkout-design-v2.html')}|true`].url)}`, 'opens-on-the-canvas');
    await check(`!${shown('aside.library-list')} && !${shown('[data-artifacts-view] > header')}`, 'list-and-sliders-put-away');
    await check(`document.querySelector('[data-library-full]').getAttribute('aria-pressed') === 'true' && document.querySelector('[data-library-full]').textContent.trim() === 'Show list'`, 'full-screen-toggle-says-show-list');
    for (let i = 0; i < 30 && await run(versions) !== 'v1 v2*'; i++) await sleep(200);
    await check(`${versions} === 'v1 v2*'`, 'becomes-the-listed-design-with-its-versions');

    // Show list brings the list back beside the design; Full screen puts it away again.
    await run(`document.querySelector('[data-library-full]').click()`); await sleep(600);
    await shot('library-list-shown');
    await check(`${shown('aside.library-list')} && document.querySelector('[data-library-full]').getAttribute('aria-pressed') === 'false' && ${canvasSrc} === ${js(urls[`${file('checkout-design-v2.html')}|true`].url)}`, 'show-list-keeps-the-design-open');
    await run(`document.querySelector('[data-library-full]').click()`); await sleep(400);
    await check(`!${shown('aside.library-list')}`, 'full-screen-again');

    // Back to Library leaves full screen for the usual browsing page.
    await run(`document.querySelector('[data-library-back]').click()`); await sleep(800);
    await check(`!document.querySelector('[data-design-canvas]') && ${shown('aside.library-list')} && ${shown('[data-artifacts-view] > header')}`, 'back-returns-to-browsing');

    // An older version the chat named opens as itself, with its design's other versions beside it.
    await backToChat();
    await press('Checkout, first pass', 'Open in Library'); await sleep(2800);
    for (let i = 0; i < 30 && await run(versions) !== 'v1* v2'; i++) await sleep(200);
    await check(`${canvasSrc} === ${js(urls[`${file('checkout-design.html')}|true`].url)} && ${versions} === 'v1* v2'`, 'older-version-opens-as-itself');
    await shot('library-older-version');

    // Narrow windows: the design has the whole width too.
    win.setContentSize(700, 900); await sleep(900);
    await shot('library-full-screen-narrow');
    await check(`!${shown('aside.library-list')} && !!document.querySelector('[data-design-canvas] iframe')`, 'narrow-full-screen');
    win.setContentSize(1440, 900); await sleep(400);

    // Open in chat: the file pane beside the chat, as before; Library is left alone.
    await run(`document.querySelector('[data-library-back]').click()`); await sleep(300);
    await backToChat();
    await press('Checkout, second pass', 'Open in chat'); await sleep(1500);
    await shot('opened-in-chat');
    await check(`layoutFixture.store.getState().view !== 'artifacts' && JSON.stringify(layoutFixture.store.getState().workspaces).includes(${js(file('checkout-design-v2.html'))})`, 'open-in-chat-opens-the-file-pane');

    report.hidden = !win.isVisible(); report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    if (report.offMachine.length) throw Error('Requests left the machine');
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ success: report.success, checks: report.checks, errors: report.errors.slice(0, 5) }, null, 2));
    await server.close?.();
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
