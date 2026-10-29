// Synthetic Simple / Expert evidence for the desktop chat; never connects to the user's host or profile.
// Run: NEKKO_FIXTURE=chat-modes-fixture.tsx NEKKO_SANDBOX=chat-modes-sandbox.cjs node chat-search-integration.cjs
// (NEKKO_TEST_REVISION=<rev> for "before"). Hidden, non-focusable, off-screen; renderer input only.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-search-integration.cjs');
const dir = path.join(out, process.env.NEKKO_TEST_REVISION ? 'before' : 'after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 1100, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic chat modes verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], bounds: null };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message.slice(0, 300)); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  const capture = async name => { await sleep(500); fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  const click = async selector => {
    const p = await run(`(()=>{const e=document.querySelector(${js(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    if (!p) return false;
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(250);
    return true;
  };
  const clickAt = async (x, y) => { for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 }); await sleep(250); };
  const has = selector => run(`!!document.querySelector(${js(selector)})`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await has('[data-session-id="alpha"] textarea')); i++) await sleep(200);
    await sleep(1200);
    report.bounds = win.getBounds();
    report.focusAtLoad = await run('document.activeElement && document.activeElement.tagName');
    await capture('1-simple');
    if (await has('[data-chat-mode]')) {
      check('starts in Simple', await run(`document.querySelector('[data-chat-mode]').dataset.chatMode === 'simple'`));
      check('no monitor strip in Simple', !(await has('[data-expert-monitor]')));
      check('context ring drawn', await has('.context-bar svg circle[stroke-dasharray]'));
      await click('[data-effort-index]');
      check('effort popover opens', await has('[data-effort-popover]'));
      await capture('2-effort');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await sleep(200);
      check('Escape closes the effort popover', !(await has('[data-effort-popover]')));
      await click('[data-effort-index]');
      await click('[data-effort="max"]');
      check('picking Max moves the dial', await run(`document.querySelector('[data-effort-index]').dataset.effortIndex === '4'`));
      // Changing effort mid-chat explains what the next reply sends (existing behaviour).
      await run(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Got it')?.setAttribute('data-got-it', '')`);
      await click('[data-got-it]');
      await clickAt(200, 650);
      await click('[data-chat-mode]');
      for (let i = 0; i < 20 && !(await has('[data-dial="GPU"]')); i++) await sleep(200);
      check('Expert shows the strip', await has('[data-expert-monitor]'));
      check('strip has CPU, Memory, GPU and VRAM dials', await run(`['CPU','Memory','GPU','VRAM'].every(l => document.querySelector('[data-expert-monitor] [data-dial="'+l+'"]'))`));
      await sleep(800);
      await capture('3-expert');
      await click('[data-expert-monitor] button');
      for (let i = 0; i < 20 && !(await has('[data-local-model]')); i++) await sleep(200);
      check('monitor popover lists the resident models', await run(`document.querySelectorAll('[data-expert-monitor-sheet] [data-local-model]').length === 2`));
      await capture('4-monitor');
      await clickAt(200, 650);
      check('an outside click closes the monitor popover', !(await has('[data-expert-monitor-sheet]')));
      win.setContentSize(760, 720); await sleep(600);
      await capture('5-expert-narrow');
      check('no horizontal page overflow at 760px', await run(`document.documentElement.scrollWidth <= innerWidth`));
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.checks.every(c => c.passed) ? 0 : 1);
});
