// Synthetic remote-photo evidence; never connects to the user's host, profile or the web.
// Launched through remote-images-integration.cjs (NEKKO_TEST_REVISION=<rev> for "before").
// Drives real renderer input (wheel, clicks, keys; no OS input) in a hidden,
// non-focusable, off-screen window. Every non-file request is cancelled, so
// the only "web photos" are the fixture's fake image:fetch.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through remote-images-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The narrow pass swaps windows; without this, closing the first quits the app.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const blocked = [];
  session.defaultSession.webRequest.onBeforeRequest((request, done) => {
    const allow = /^(file:|data:|blob:|devtools:)/.test(request.url);
    if (!allow) blocked.push(request.url);
    done({ cancel: !allow });
  });
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const report = { checks: [], errors: [], measures: {} };
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  let win;
  const open = async (width, height) => {
    if (win) { win.destroy(); await sleep(500); }
    win = new BrowserWindow({
      width, height, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
      x: left - 3000, y: -2000, title: 'Synthetic remote photos verification',
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.on('focus', () => report.errors.push('Fixture took focus'));
    win.webContents.on('console-message', (e) => { if (e.level === 'error' && !/ERR_BLOCKED|net::/.test(e.message)) report.errors.push('console: ' + e.message); });
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1500);
  };
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const capture = async (name) => { await sleep(400); fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  const center = (selector) => run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  const mouse = async (selector, button = 'left') => {
    const p = await center(selector);
    if (!p) return false;
    await sleep(150);
    const q = await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: q.x, y: q.y, button, clickCount: 1 });
    if (button === 'right') win.webContents.sendInputEvent({ type: 'contextMenu', x: q.x, y: q.y });
    await sleep(200);
    return true;
  };
  const key = async (keyCode) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(200); };
  const scrollTo = (where) => run(`(()=>{const s=document.querySelector('[data-transcript-scroll]');s.scrollTop=${where === 'top' ? 0 : 's.scrollHeight'};return Math.round(s.scrollTop)})()`);
  const cards = () => run(`[...document.querySelectorAll('[data-remote-image]')].map(e=>({url:e.dataset.remoteImage,state:e.dataset.state,tile:!!e.closest('[data-photo-gallery]'),img:!!e.querySelector('img'),src:(e.querySelector('img')||{}).src?.slice(0,22)||null}))`);

  try {
    await open(1100, 820);
    for (const theme of ['dark', 'light']) {
      await run(`integration.delay=700;document.documentElement.dataset.theme='${theme}'`);
      await run('integration.reset()'); await sleep(1500);
      await scrollTo('bottom'); await sleep(600);
      // Lazy: the photo reply is far above the fold, so nothing has been fetched.
      const atBottom = await run('integration.stats()');
      if (!base) check(`nothing is fetched while the photos are off-screen (${theme})`, atBottom.fetched.length === 0);
      await scrollTo('top'); await sleep(250);
      await capture(`loading-${theme}`);
      const loading = await cards();
      report.measures[`loading-${theme}`] = loading;
      if (base) {
        const links = await run(`[...document.querySelectorAll('a')].filter(a=>/img\\.example|cdn\\.shop|tracker/.test(a.href)).length`);
        report.measures[`base-links-${theme}`] = links;
        await sleep(1200);
        await capture(`chat-${theme}`);
        continue;
      }
      check(`photos show a loading skeleton while the host fetches them (${theme})`, loading.some((c) => c.state === 'loading'));
      await sleep(2400);
      const loaded = await cards();
      report.measures[`loaded-${theme}`] = loaded;
      const stats = await run('integration.stats()');
      report.measures[`stats-${theme}`] = stats;
      check(`trusted photos load, through the host, as data URLs (${theme})`, loaded.filter((c) => c.url !== 'https://tracker.example.net/pixel.png?chat=wall-mount').every((c) => c.state === 'ready' && c.src === 'data:image/png;base64,'));
      check(`the three photos in a row form one gallery, the first stands alone (${theme})`, loaded.filter((c) => c.tile).length === 3 && !loaded[0].tile);
      check(`the URL only the model wrote is not fetched and waits for a click (${theme})`, !stats.fetched.some((u) => u.includes('tracker')) && loaded.find((c) => c.url.includes('tracker'))?.state === 'blocked');
      check(`at most 4 fetches run at once (${theme})`, stats.peak <= 4);
      check(`the renderer itself requested nothing from the web (${theme})`, blocked.length === 0);
      await capture(`chat-${theme}`);
      await run(`document.querySelector('[data-remote-image*="tracker"]').scrollIntoView({block:'center'})`);
      await capture(`blocked-${theme}`);

      // Click to load the untrusted one.
      const clicked = await mouse('[data-remote-image*="tracker"] button');
      await sleep(1200);
      const after = await run(`document.querySelector('[data-remote-image*="tracker"]').dataset.state`);
      check(`Load image fetches it on request (${theme})`, clicked && after === 'ready' && (await run('integration.stats()')).fetched.some((u) => u.includes('tracker')));

      // Viewer from the gallery's second tile, then step with the arrow keys.
      await mouse('[data-photo-gallery] [data-remote-image]:nth-child(2) button');
      await sleep(500);
      const v1 = await run(`(()=>{const v=document.querySelector('[data-photo-viewer]');if(!v)return null;const img=v.querySelector('img');return {counter:v.textContent.match(/\\d+ \\/ \\d+/)?.[0],src:img?.src.slice(0,22),w:img?Math.round(img.getBoundingClientRect().width):0,label:document.querySelector('[role=dialog]').getAttribute('aria-labelledby')&&document.querySelector('[role=dialog] h2')?.textContent}})()`);
      report.measures[`viewer-${theme}`] = v1;
      check(`clicking a gallery photo opens the viewer on that photo (${theme})`, v1 && v1.counter === '2 / 3' && v1.src === 'data:image/png;base64,' && v1.w > 500);
      await capture(`viewer-${theme}`);
      await key('Right');
      const v2 = await run(`document.querySelector('[data-photo-viewer]').textContent.match(/\\d+ \\/ \\d+/)?.[0]`);
      await key('Right');
      const v3 = await run(`document.querySelector('[data-photo-viewer]').textContent.match(/\\d+ \\/ \\d+/)?.[0]`);
      await mouse('[aria-label="Previous photo"]');
      const v4 = await run(`document.querySelector('[data-photo-viewer]').textContent.match(/\\d+ \\/ \\d+/)?.[0]`);
      check(`arrow keys and buttons step through the gallery, wrapping (${theme})`, v2 === '3 / 3' && v3 === '1 / 3' && v4 === '3 / 3');

      // Right-click inside the viewer: the full menu over it.
      await mouse('[data-photo-viewer] img', 'right');
      await sleep(250);
      const menu = await run(`[...document.querySelectorAll('[aria-label="Image actions"] [role=menuitem]')].map(b=>b.textContent)`);
      report.measures[`menu-${theme}`] = menu;
      check(`right-click offers copy, save, copy address and open original (${theme})`, JSON.stringify(menu) === JSON.stringify(['Copy image', 'Save image…', 'Copy image address', 'Open original in browser']));
      await capture(`viewer-menu-${theme}`);
      await mouse('[aria-label="Image actions"] [role=menuitem]:nth-child(5)');
      const opened = await run('window.opened');
      check(`Open original hands the https URL to the OS browser (${theme})`, opened === 'https://cdn.shop.example/p/mh-853-installed.webp');
      check(`the menu closed and the viewer stayed open (${theme})`, await run(`!document.querySelector('[aria-label="Image actions"]') && !!document.querySelector('[data-photo-viewer]')`));
      await key('Escape'); await sleep(300);
      check(`Escape closes the viewer (${theme})`, !(await run(`!!document.querySelector('[data-photo-viewer]')`)));

      // Right-click on a card in the transcript.
      await mouse('[data-remote-image] button', 'right');
      await capture(`card-menu-${theme}`);
      await key('Escape');
    }
    // A narrow pane: the gallery reflows to two columns.
    if (!base) {
      await open(480, 820);
      await run(`integration.delay=50;document.documentElement.dataset.theme='dark'`);
      await run('integration.reset()'); await sleep(1500);
      await scrollTo('top'); await sleep(1500);
      await run(`document.querySelector('[data-photo-gallery]').scrollIntoView({block:'center'})`);
      const cols = await run(`getComputedStyle(document.querySelector('[data-photo-gallery]')).gridTemplateColumns.split(' ').length`);
      report.measures.narrowColumns = cols;
      check('a narrow pane lays the gallery out in two columns', cols === 2);
      await capture('narrow-dark');
    }
    report.success = !report.errors.some((e) => /focus/.test(e)) && (base || report.checks.every((c) => c.passed));
  } catch (error) {
    report.errors.push(String((error && error.stack) || error)); report.success = false;
  } finally {
    report.blocked = blocked;
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, failed: report.checks.filter((c) => !c.passed).map((c) => c.name), passed: report.checks.filter((c) => c.passed).length, total: report.checks.length, errors: [...new Set(report.errors)].slice(0, 6), blocked: blocked.slice(0, 5) }, null, 2));
    win?.destroy(); app.exit(report.success ? 0 : 1);
  }
});
