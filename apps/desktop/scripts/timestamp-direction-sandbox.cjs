// Hidden, isolated timestamp direction, cap, reversal and release evidence.
// Run through chat-search-integration.cjs. Base captures use the same journey.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-search-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'direction-before' : 'direction-after');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -3000, y: -2000, title: 'Timestamp swipe verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], measures: {}, background: {} };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = (name, passed) => report.checks.push({ name, passed: !!passed });
  const capture = async name => fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  const state = () => run(`(()=>{const s=document.querySelector('[data-transcript-scroll]'),l=s.querySelector('.vt-list');return {transform:l.style.transform,stamps:s.classList.contains('vt-stamps-on'),swiping:s.classList.contains('vt-swiping'),revealing:s.classList.contains('vt-revealing'),scrollLeft:s.scrollLeft}})()`);
  const wheel = dx => run(`document.querySelector('[data-transcript-scroll]').dispatchEvent(new WheelEvent('wheel',{deltaX:${dx},deltaY:0,bubbles:true,cancelable:true}))`);
  try {
    await win.loadFile(path.join(out, 'index.html'), { hash: 'timestamp-swipe' });
    await sleep(1200);
    for (const width of [1100, 430]) {
      win.setContentSize(width, 760);
      await run('integration.reset()'); await sleep(1200);
      await run(`document.querySelector('[data-transcript-scroll] button[aria-expanded="false"]')?.click()`); await sleep(300);
      await capture('rest-' + width);
      // DOM wheel signs: positive X scrolls the content left, negative X right.
      for (let i = 0; i < 8; i++) { await wheel(-18); await sleep(16); }
      const right = await state(); report.measures['right-' + width] = right;
      check('rightward swipe stays closed at ' + width, !right.stamps && !right.swiping && !right.transform);
      await capture('right-' + width); await sleep(800);
      const frames = [];
      const frame = async () => frames.push((await win.capturePage(undefined, { stayHidden: true })).toPNG());
      await frame();
      for (let i = 0; i < 8; i++) { await wheel(18); await sleep(16); await frame(); }
      const held = await state(); report.measures['left-' + width] = held;
      check('leftward swipe stops at 112px at ' + width, held.transform === 'translateX(-112px)' && held.stamps);
      await capture('left-' + width);
      await sleep(100);
      const idle = await state(); report.measures['idle-100ms-' + width] = idle;
      check('wheel starts return within 100ms at ' + width, !idle.swiping && !idle.stamps);
      await capture('idle-100ms-' + width); await frame();
      for (let i = 0; i < 12; i++) { await sleep(35); await frame(); }
      require('./evidence-gif.cjs')(path.join(dir, 'release-' + width + '.gif'), frames);
      const released = await state(); report.measures['released-' + width] = released;
      check('wheel has released without the old hold at ' + width, !released.swiping && !released.revealing && !released.stamps && !released.transform);
      await capture('released-' + width); await sleep(500);
      await wheel(500); await wheel(-20);
      const reversed = await state(); report.measures['reversed-' + width] = reversed;
      check('wheel reverses immediately from cap at ' + width, reversed.transform === 'translateX(-92px)');
      await sleep(800);
      // Actual renderer mouse input, not OS input. Start in blank transcript space.
      const origin = await run(`(()=>{const r=document.querySelector('[data-transcript-scroll]').getBoundingClientRect();return {x:Math.round(r.right-24),y:Math.round(r.bottom-20)}})()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', ...origin, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: origin.x - 240, y: origin.y, button: 'left' });
      await sleep(600);
      const drag = await state(); check('stationary drag holds cap at ' + width, drag.transform === 'translateX(-112px)' && drag.swiping);
      await capture('drag-' + width);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: origin.x - 220, y: origin.y, button: 'left' });
      await sleep(30);
      const reverseDrag = await state(); check('drag reverses immediately from cap at ' + width, reverseDrag.transform === 'translateX(-92px)');
      win.webContents.sendInputEvent({ type: 'mouseUp', x: origin.x - 220, y: origin.y, button: 'left', clickCount: 1 });
      await sleep(20); const up = await state(); check('pointer-up starts return immediately at ' + width, !up.swiping && !up.stamps && up.transform === 'translateX(0px)');
      await sleep(300); const settled = await state(); check('pointer-up clears transform and horizontal scroll at ' + width, !settled.transform && settled.scrollLeft === 0);
    }
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
    check('window remained hidden and non-focusable', !report.background.visible && !report.background.focusable);
    report.success = report.errors.length === 0 && (base || report.checks.every(c => c.passed));
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, ...report }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
