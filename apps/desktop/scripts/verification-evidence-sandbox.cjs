// Hidden full-app evidence; isolated profile, stubbed files, no network or OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'verification-profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [] };
// For a matched comparison, require the image tap to do nothing on base and
// to open the same image on head. The usual placement captures still run.
const viewerMode = process.env.NEKKO_VERIFY_PHOTO_VIEWER;
const assert = require('node:assert/strict');
// Synthetic illustration content: fixture only, never claimed as real UI evidence.
const svg = side => `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect width="600" height="240" fill="${side === 'Before' ? '#334155' : '#0f766e'}"/><text x="30" y="130" font-size="30" fill="white">${side}: fixture screenshot</text></svg>`;
const reply = 'Updated the example surface. These are fixture illustrations for testing the comparison UI.\n\n![Before: Example surface](C:/demo/before.svg)\n![After: Example surface](C:/demo/after.svg)\n\n**Verified**\nCaptured fixture images only; not approved.\n\n**Next step**\nCompare both screenshots and review the visual change.';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:|about:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const displays = screen.getAllDisplays();
  const win = new BrowserWindow({ width: 1440, height: 1000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...displays.map(d => d.bounds.x)) - 1700, y: -1500, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  win.on('focus', () => report.errors.push('Window received focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-command-wall]")'); i++) await sleep(100);
    await run(`(() => {
      const f = window.layoutFixture;
      window.evidenceOpened = [];
      f.store.setState({ openFilePane: (p, s) => window.evidenceOpened.push({ path:p, session:s }) });
      f.bridge.readFile = async p => ({ content: p.endsWith('before.svg') ? ${JSON.stringify(svg('Before'))} : ${JSON.stringify(svg('After'))}, binary: false, truncated: false });
      const s = f.records[0];
      s.messages = [{ id:'u1', role:'user', content:'Update this surface.', createdAt:Date.now()-60000 }, { id:'a1', role:'assistant', content:${JSON.stringify(reply)}, createdAt:Date.now()-30000 }];
      f.putCachedSession(s); f.store.getState().openChatPane(s.id);
      const st = f.store.getState(); f.store.setState({ settings:{...st.settings,commandWall:{...(st.settings.commandWall||{}),dock:{show:false}}} });
    })()`);
    await sleep(500);
    await run(`(() => { const hit = [...document.querySelectorAll('button,[role="button"],a,[tabindex]')].find(e => e.textContent.includes('Persist quota history') || e.textContent.includes('Persist qu')); hit?.click(); })()`);
    await sleep(2500);
    await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}');
    if (viewerMode) {
      for (const width of [1440, 480]) {
        win.setContentSize(width, 900);
        for (const side of ['Before', 'After']) {
          const placement = side === 'Before' ? 'inline' : 'next-step';
          const selector = JSON.stringify(`[data-verification-evidence="${placement}"] img[alt^="${side}:"]`);
          assert(await run(`!!document.querySelector(${selector})`), `${width}: missing ${placement} ${side} image`);
          const metrics = await run(`(() => {
            const img = document.querySelector(${selector});
            img.scrollIntoView({block:'center', behavior:'instant'});
            const button = img.closest('button');
            button?.focus({preventScroll:true});
            return {src:img.getAttribute('src'), alt:img.alt, button:button?.getAttribute('aria-label') ?? null};
          })()`);
          await sleep(150);
          const point = await run(`(() => {
            const r = document.querySelector(${selector}).getBoundingClientRect();
            const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
            return {x, y, hit:document.elementFromPoint(x,y) === document.querySelector(${selector})};
          })()`);
          assert(point.hit, `${width}: the ${side} image must be hit-testable`);
          win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
          await sleep(250);
          const shown = await run(`(() => {
            const viewer = document.querySelector('[data-photo-viewer]');
            const img = viewer?.querySelector('img');
            return viewer ? {src:img?.getAttribute('src'), alt:img?.alt, modal:viewer.closest('[role="dialog"]')?.getAttribute('aria-modal')} : null;
          })()`);
          if (viewerMode === 'head') {
            assert.equal(metrics.button, `Open ${metrics.alt} in photo viewer`);
            assert.deepEqual(shown, { src: metrics.src, alt: metrics.alt, modal: 'true' });
          } else {
            assert.equal(metrics.button, null);
            assert.equal(shown, null);
          }
          const file = path.join(out, `viewer-${viewerMode}-${width}-${side.toLowerCase()}.png`);
          fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden:true })).toPNG());
          report.captures.push(file);
          if (shown) {
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
            await sleep(150);
            assert(await run(`!document.querySelector('[data-photo-viewer]') && document.activeElement === document.querySelector(${selector}).closest('button')`), 'Escape must close and return focus');
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
            await sleep(150);
            assert(await run(`document.querySelector('[data-photo-viewer] img')?.alt === ${JSON.stringify(metrics.alt)}`), 'Space must open the same image');
            await run(`document.querySelector('[data-photo-viewer] [aria-label="Close image"]').click()`);
            await sleep(150);
            assert(await run(`!document.querySelector('[data-photo-viewer]')`), 'Close must dismiss the viewer');
          }
        }
      }
    } else for (const theme of ['dark','light']) for (const width of [1440,720]) {
      win.setContentSize(width,1000);
      await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await sleep(600);
      for (const place of ['inline','next-step']) {
        await run(`(document.querySelector('[data-verification-evidence="${place}"]') || document.querySelector('[data-chat-surface]'))?.scrollIntoView({block:'center'})`);
        await sleep(400);
        const file = path.join(out, `${theme}-${width}-${place}.png`);
        fs.writeFileSync(file, (await win.capturePage(undefined,{stayHidden:true})).toPNG()); report.captures.push(file);
      }
    }
    report.metrics = await run(`(() => { const panels=[...document.querySelectorAll('[data-verification-evidence]')]; const images=panels.map(p=>({place:p.dataset.verificationEvidence, images:p.querySelectorAll('img').length})); const button=[...document.querySelectorAll('[data-verification-evidence="next-step"] button')].find(b=>b.textContent.includes('Open source')); button?.click(); return {images,opened:window.evidenceOpened}; })()`);
    if (viewerMode) {
      assert.deepEqual(report.metrics.images, [{ place: 'inline', images: 2 }, { place: 'next-step', images: 2 }]);
      assert.deepEqual(report.metrics.opened, [{ path:'C:/demo/before.svg', session:'a' }]);
    }
    if (win.isVisible() || win.isFocused()) report.errors.push('Window visible or focused');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  finally { fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); win.destroy(); app.exit(report.errors.length ? 1 : 0); }
});
