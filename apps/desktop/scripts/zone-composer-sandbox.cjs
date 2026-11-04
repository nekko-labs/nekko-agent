// Real renderer, stub host, disposable profile. Never shows a window or sends OS input.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const writeGif = require('./evidence-gif.cjs');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with layout-evidence-integration.cjs');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const baseline = process.env.NEKKO_TEST_BASELINE === '1';
const report = { assertions: [], captures: [], errors: [] };
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -1700, y: -1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await sleep(100); const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, expression) => { const passed = !!await run(expression); report.assertions.push({ name, passed }); if (!passed) throw Error(name); };
  const pointer = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x, y, ...(type === 'mouseMove' && extra.button === 'left' ? { modifiers: ['leftButtonDown'] } : {}), ...extra });
  const frame = async frames => { frames.push((await win.capturePage({ x: 210, y: 120, width: 960, height: 620 }, { stayHidden: true })).toPNG()); await sleep(70); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!window.layoutFixture && !!document.querySelector("[data-command-wall]")'); i++) await sleep(200);
    await run(`localStorage.setItem('nekko.commandWall',JSON.stringify({layout:{mode:'grid',cols:2,rows:1},root:{id:'split_fixture',dir:'row',sizes:[0.5,0.5],children:[{id:'pane_a',kind:'chat',refId:'a',zone:'Zone 1',tint:0},{id:'pane_b',kind:'chat',refId:'b',zone:'Zone 2',tint:1}]},watermark:Date.now(),autoAdd:false,hero:'a',zonesIntro:true})); location.reload()`);
    await sleep(2200);
    await check('two zones', `document.querySelectorAll('.wall-zone-header').length === 2`);
    const p = await run(`(() => { const r = document.querySelector('.wall-zone-header').getBoundingClientRect(); return { x: Math.round(r.left + 110), y: Math.round(r.top + r.height / 2) }; })()`);
    const lifted = `!!document.querySelector('.wall-held-card')`;
    report.heldSelectors = await run(`Array.from(document.querySelectorAll('[class]')).map(e=>e.className).filter(c=>typeof c==='string'&&c.includes('held'))`);
    const frames = [];
    pointer('mouseMove', p.x, p.y); await sleep(100); await frame(frames);
    pointer('mouseDown', p.x, p.y, { button: 'left', clickCount: 1 }); await sleep(120); await frame(frames);
    await shot('zone-pressed');
    if (!baseline) await check('press does not lift', `!document.querySelector('.wall-held-card, .wall-held')`);
    pointer('mouseUp', p.x, p.y, { button: 'left', clickCount: 1 }); await sleep(250); await frame(frames);
    pointer('mouseDown', p.x, p.y, { button: 'left', clickCount: 1 }); await sleep(100); await frame(frames);
    pointer('mouseMove', p.x + 1, p.y, { button: 'left' }); await sleep(160); await frame(frames);
    await shot('zone-first-move');
    report.liftedClasses = await run(`Array.from(document.querySelectorAll('[class]')).map(e=>e.className).filter(c=>typeof c==='string'&&/held|lift/.test(c))`);
    if (!baseline) await check('first changed coordinate lifts', `!!document.querySelector('.wall-held-card, .wall-held')`);
    for (let i = 1; i <= 7; i++) { pointer('mouseMove', p.x + 20 * i, p.y + 12 * i, { button: 'left' }); await frame(frames); }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    pointer('mouseUp', p.x + 140, p.y + 84, { button: 'left', clickCount: 1 }); await sleep(300); await frame(frames);
    writeGif(path.join(out, 'zone-click-drag.gif'), frames, 15);
    if (!baseline) {
      await check('Escape clears pickup', `!document.querySelector('.wall-held-card, .wall-held')`);
      // Abandoned presses must never start dragging on a later move.
      for (const cancel of ['pointerup', 'pointercancel', 'blur', 'Escape']) {
        await run(`(() => { const h=document.querySelector('.wall-zone-header'); h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,buttons:1,pointerId:42,clientX:${p.x},clientY:${p.y}})); ${cancel === 'Escape' ? "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))" : cancel === 'blur' ? "window.dispatchEvent(new Event('blur'))" : "window.dispatchEvent(new PointerEvent('" + cancel + "',{pointerId:42}))"}; window.dispatchEvent(new PointerEvent('pointermove',{pointerId:42,buttons:1,clientX:${p.x + 4},clientY:${p.y}})); })()`);
        await sleep(80);
        await check(cancel + ' disarms pending pickup', `!document.querySelector('.wall-held-card')`);
      }
    }
    for (const surface of ['composer', 'window', 'full']) {
      await run(`layoutFixture.showComposer(${js(surface)})`); await sleep(800);
      await run(`layoutFixture.emitAgent({sessionId:'a',type:'text',text:'Working'})`); await sleep(350);
      for (const width of [1440, 390]) {
        win.setContentSize(width, 900); await sleep(450);
        await shot(surface + '-running-' + width);
        if (!baseline) {
          await check(surface + ' has one Stop action ' + width, `document.querySelectorAll('[data-composer-action="stop"]').length === 1 && !document.querySelector('[data-composer-action="stop"]').disabled`);
          await check(surface + ' has no standalone Automate ' + width, `!document.querySelector('[aria-label="Automate: schedule, repeat, or run in the background"]')`);
          await check(surface + ' borderless transparent action ' + width, `(() => { const s=getComputedStyle(document.querySelector('[data-composer-action]')); return s.backgroundColor==='rgba(0, 0, 0, 0)' && s.borderTopWidth==='0px'; })()`);
        }
      }
      win.setContentSize(1440, 900); await sleep(200);
      if (!baseline) {
        await run(`document.querySelector('[aria-label="Add a photo, video, file, folder, or skill"]').click()`); await sleep(100);
        await check(surface + ' automation remains in plus menu', `!!document.querySelector('[data-plus-automate]')`);
        await run(`document.querySelector('[aria-label="Add a photo, video, file, folder, or skill"]').click()`);
      }
      // Real editor keyboard input, not a React-state shortcut.
      await run(`document.querySelector('[contenteditable]:not([contenteditable="false"]),textarea').focus()`);
      win.webContents.insertText('Please continue'); await sleep(400);
      await shot(surface + '-draft');
      if (!baseline) {
        await check(surface + ' draft switches to Send', `!!document.querySelector('[data-composer-action="send"][aria-label="Add to queue"]') && !document.querySelector('[data-composer-action="send"]').disabled`);
        await run(`document.querySelector('[data-composer-action="send"]').click()`); await sleep(500);
        await check(surface + ' send reaches host without aborting', `layoutFixture.lastQueue?.sessionId === 'a' && !layoutFixture.lastAbort`);
        await check(surface + ' clearing sent draft restores Stop', `!!document.querySelector('[data-composer-action="stop"]')`);
        await run(`document.querySelector('[data-composer-action="stop"]').click()`); await sleep(100);
        await check(surface + ' Stop reaches abort host', `layoutFixture.lastAbort === 'a'`);
        await run(`delete layoutFixture.lastAbort; delete layoutFixture.lastQueue`);
      } else {
        await run(`document.querySelector('[aria-label="Add to queue"]').click()`); await sleep(500);
      }
    }
    report.hidden = !win.isVisible(); report.bounds = win.getBounds();
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
