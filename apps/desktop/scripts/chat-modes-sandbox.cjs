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
    const text = sel => run(`[...document.querySelectorAll(${js(sel)})].map(e => e.textContent.trim()).join(' | ')`);
    check('starts in Simple', await run(`document.querySelector('[data-chat-mode]')?.dataset.chatMode === 'simple'`));
    check('Simple: details panel sits inside the composer card', await has('.composer [data-composer-details]'));
    for (let i = 0; i < 30 && !(await has('[data-expert-monitor]')); i++) await sleep(200);
    check('Simple: model, effort and context shown; tools and Mode out of sight', (await has('[data-composer-details] button[aria-haspopup="listbox"]')) && (await has('.context-bar')) && (await has('[data-effort-index]')) && !(await has('[data-chat-mode-button]')) && !(await has('[data-agent-footer-controls] .ctl-menu')));
    check('Simple: the hardware strip shows while a local model is loaded', await has('[data-expert-monitor]'));
    check('Simple: a nearly full chat says what starting fresh saves', /Starting fresh saves about 162k tokens/.test(await text('[data-chat-long]')));
    check('Simple: the turn\'s steps fold to one line', /Took 2 steps/.test(await text('[data-simple-steps]')));
    await capture('1-simple');
    await run(`[...document.querySelectorAll('[data-simple-steps] button')].find(b => b.textContent === 'Show steps')?.click()`); await sleep(300);
    check('Show steps opens that turn\'s steps', (await run(`document.querySelector('[data-simple-steps] button').getAttribute('aria-expanded')`)) === 'true');
    await capture('1b-simple-steps-shown');
    await run(`document.querySelector('[data-simple-steps] button').click()`); await sleep(200);
    await click('.composer-details-toggle');
    check('details shrink to the model alone', (await run(`document.querySelector('.composer-details-toggle').getAttribute('aria-expanded')`)) === 'false');
    await capture('2-simple-shrunk');
    await click('.composer-details-toggle');
    await click('[data-chat-mode] button[aria-label^="Expert"]');
    for (let i = 0; i < 20 && !(await has('[data-dial="GPU"]')); i++) await sleep(200);
    check('Expert: no getting-long note', !(await has('[data-chat-long]')));
    check('Expert: steps are not folded to one line', !(await has('[data-simple-steps]')));
    check('Expert: effort, context, Mode, tools and the strip are shown', (await has('[data-effort-index]')) && (await has('.context-bar')) && (await has('[data-chat-mode-button]')) && (await has('[data-expert-monitor]')) && (await has('[data-agent-footer-controls] .ctl-menu')));
    await sleep(800);
    await capture('3-expert');
    await click('.composer-details-toggle');
    check('Expert shrunk keeps the model only', !(await has('[data-effort-index]')) && !(await has('.context-bar')) && (await has('[data-composer-details] button[aria-haspopup="listbox"]')));
    await capture('4-expert-shrunk');
    await click('.composer-details-toggle');
    win.setContentSize(760, 720); await sleep(600);
    await capture('5-expert-narrow');
    check('no horizontal page overflow at 760px', await run(`document.documentElement.scrollWidth <= innerWidth`));
    win.setContentSize(1100, 720);
    // Settings > Simple mode, back in Simple.
    await run(`localStorage.setItem('nekko.chatMode','simple'); location.hash = '#settings'; location.reload()`);
    for (let i = 0; i < 50 && !(await has('[data-simple-mode-settings]')); i++) await sleep(200);
    await sleep(800);
    check('settings list every desktop area', (await run(`document.querySelectorAll('[data-simple-area]').length`)) === 7);
    check('Simple preview dashes the Mode panel', await run(`document.querySelector('[data-simple-area="Chat · message box"] [data-mock-item="mode"]').dataset.shown === 'false'`));
    await capture('6-settings-simple-preview');
    await click('[data-simple-item="mode"] button[role="radio"]:first-child');
    check('choosing Show for the Mode panel draws it in the Simple preview', await run(`document.querySelector('[data-mock-item="mode"]').dataset.shown === 'true'`));
    await run(`document.querySelector('[data-simple-area="Chat · message box"]').scrollIntoView({block:'start'})`);
    await run(`document.querySelector('[data-simple-item="context"]').dispatchEvent(new MouseEvent('mouseover', {bubbles:true}))`);
    await sleep(300);
    await capture('7-settings-mode-shown');
    await run(`document.querySelector('[aria-label="Preview Expert"]').click()`); await sleep(300);
    check('Expert preview shows the context ring', await run(`document.querySelector('[data-mock-item="context"]').dataset.shown === 'true'`));
    await capture('8-settings-expert-preview');
    await run(`location.hash = ''; location.reload()`);
    for (let i = 0; i < 50 && !(await has('[data-session-id="alpha"] textarea')); i++) await sleep(200);
    await sleep(1000);
    check('the chat honours the choice: the Mode panel shows in Simple', (await run(`document.querySelector('[data-chat-mode]')?.dataset.chatMode`)) === 'simple' && (await has('[data-chat-mode-button]')));
    await capture('9-simple-with-mode');
    report.text = await text('[data-composer-details]');
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.checks.every(c => c.passed) ? 0 : 1);
});
