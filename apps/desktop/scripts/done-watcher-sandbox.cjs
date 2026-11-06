const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = process.env.NEKKO_DONE_WATCHER_DIR;
if (!dir) throw Error('Launch through done-watcher-integration.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nekko-done-watcher-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.commandLine.appendSwitch('disable-background-networking');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { captures: [], errors: [], blockedRequests: [], checks: [], profile, inspectedVisually: false };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const allowed = /^(file:|data:|blob:)/.test(details.url);
    if (!allowed) report.blockedRequests.push(details.url);
    done({ cancel: !allowed });
  });
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, x: -10000, y: -10000, show: false, focusable: false, skipTaskbar: true, title: 'Done watcher evidence (isolated)', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 3) report.errors.push(event.message); });
  win.webContents.on('render-process-gone', (_, details) => report.errors.push(JSON.stringify(details)));
  try {
    for (const target of [{ name: 'desktop', width: 1280, height: 900 }, ...['sidebar', 'wall', 'composer'].map(surface => ({ name: `phone-web-${surface}`, width: 390, height: 844, surface }))]) {
      win.setContentSize(target.width, target.height);
      await win.loadFile(path.join(dir, 'index.html'), { query: target.surface ? { surface: target.surface } : {} });
      await sleep(700);
      const dom = await win.webContents.executeJavaScript(`(() => {
        const bounds = el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; };
        return { evidence: window.doneWatcherEvidence, viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, devicePixelRatio }, theme: document.documentElement.dataset.theme, articles: [...document.querySelectorAll('[data-case]')].map(el => ({ surface:el.closest('[data-surface]').dataset.surface, case:el.dataset.case, status:el.dataset.resolvedStatus, bounds:bounds(el), glyphs:[...el.querySelectorAll('[role="img"]')].map(g => ({ label:g.getAttribute('aria-label'), title:g.getAttribute('title'), color:getComputedStyle(g).color, bounds:bounds(g), svgBounds:g.querySelector('svg') ? bounds(g.querySelector('svg')) : null, svg:g.querySelector('svg')?.outerHTML })) })) };
      })()`);
      const expectedCount = target.surface ? 5 : 15;
      if (dom.articles.length !== expectedCount || dom.articles.some(a => !a.glyphs.length)) throw Error(`Missing real glyphs in ${target.name}`);
      const build = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
      const baseline = build.revision !== 'working-tree';
      const expected = { count0: baseline ? 'undefined' : 'done', count1: baseline ? 'undefined' : 'idle', working: 'working', input: 'input', error: 'error' };
      for (const article of dom.articles) {
        if (article.status !== expected[article.case]) throw Error(`${target.name}/${article.case}: expected ${expected[article.case]}, got ${article.status}. Is the parent implementation ready?`);
        for (const glyph of article.glyphs) {
          const b = glyph.bounds;
          if (!glyph.label || !glyph.svg || b.width <= 0 || b.height <= 0 || b.x < 0 || b.y < 0 || b.x + b.width > target.width || b.y + b.height > target.height) throw Error(`Invalid or clipped glyph in ${target.name}/${article.case}`);
        }
      }
      if (dom.viewport.scrollWidth > target.width || dom.viewport.scrollHeight > target.height) throw Error(`Overflow in ${target.name}: ${JSON.stringify(dom.viewport)}`);
      if (win.isVisible() || win.isFocusable() || win.isFocused()) throw Error('Window isolation invariant failed');
      const file = path.join(dir, `${target.name}.png`);
      const image = await win.capturePage(undefined, { stayHidden: true });
      if (image.isEmpty()) throw Error(`Empty capture: ${target.name}`);
      fs.writeFileSync(file, image.toPNG());
      report.captures.push({ file, imageSize: image.getSize(), windowBounds: win.getBounds(), visible: win.isVisible(), focusable: win.isFocusable(), focused: win.isFocused(), dom });
      report.checks.push(`${target.name}: ${expectedCount} real glyphs, no viewport overflow, hidden/nonfocusable`);
    }
  } catch (error) { report.errors.push(String(error)); }
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ captures: report.captures.map(c => c.file), errors: report.errors, checks: report.checks }, null, 2));
  win.destroy();
  app.exit(report.errors.length ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });
