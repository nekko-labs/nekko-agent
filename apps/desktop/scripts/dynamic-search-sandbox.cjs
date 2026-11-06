// Real Dynamic wall, synthetic data only. No host, network, OS input or user profile.
// Run via chat-search-integration.cjs with NEKKO_FIXTURE=wall-polish-fixture.tsx
// and NEKKO_SANDBOX=dynamic-search-sandbox.cjs. NEKKO_TEST_REVISION captures the base.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-search-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'dynamic-before' : 'dynamic-after');
fs.mkdirSync(dir, { recursive: true });
const profile = path.join(dir, 'profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1500, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -9000, y: -9000,
    title: 'Dynamic search isolated verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  const report = { checks: [], errors: [], states: [], console: [] };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.console.push(e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = (name, passed) => report.checks.push({ name, passed: !!passed });
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(200);
  };
  const click = async selector => {
    // The selector is test-authored, never host or user content.
    const encoded = JSON.stringify(selector).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\//g, '\\u002f');
    await run(`(()=>{const e=document.querySelector(${encoded});if(!e)throw Error('Missing fixture target: '+${encoded});document.activeElement?.blur();e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));if(e.matches('button,input,textarea,[contenteditable]'))e.focus();e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));e.click();})()`);
    await sleep(200);
    report.states.push({ click: selector, ...(await state()) });
  };
  const state = () => run(`({ selected: document.querySelector('[data-wall-selected]')?.getAttribute('data-grid-cell'), open: [...document.querySelectorAll('[data-chat-search]')].map(e=>e.closest('[data-session-id]').dataset.sessionId), focused: document.activeElement?.closest('[data-session-id]')?.dataset.sessionId })`);
  const reset = async (focus = false) => { await run(`integration.reset({focus:${focus}})`); await sleep(1200); };
  const expectTarget = async (name, id) => { await key('F', ['control']); const s = await state(); report.states.push({ name, ...s }); check(name, s.open.length === 1 && s.open[0] === id && s.focused === id); };
  const capture = async name => fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1500);
    await reset();
    check('Dynamic shows two full chat panes', await run(`document.querySelectorAll('[data-wall-pane] [data-chat-surface="full"]').length===2`));
    await click('[data-session-id="beta"] [data-transcript-scroll] p');
    await expectTarget('Clicking second transcript opens search only in beta', 'beta');
    await capture('dynamic-second-transcript');
    await reset();
    await click('[data-grid-cell="chat:beta"] [data-shortcut-pane] > div:first-child');
    await expectTarget('Clicking second title bar opens search only in beta', 'beta');
    await reset();
    await click('[data-session-id="beta"] [contenteditable="plaintext-only"]');
    await expectTarget('Keyboard focus in beta composer stays in beta', 'beta');
    await key('Escape');
    check('Escape closes the pane-local search', await run(`!document.querySelector('[data-chat-search]')`));
    await click('[data-session-id="alpha"] [data-transcript-scroll] p');
    await expectTarget('Switching back to first transcript searches alpha', 'alpha');
    await reset(true);
    await expectTarget('Focused layout searches its visible chat', 'alpha');
    await reset();
    await click('[data-session-id="beta"] [data-transcript-scroll] p');
    await expectTarget('Repeated second-pane selection remains pane-local', 'beta');
    await capture('dynamic-final');
    await key('Escape');
    await click('[data-session-id="beta"] [data-transcript-scroll] p');
    await key('F', ['meta']);
    const cmd = await state();
    check('Cmd+F uses the same selected-window routing', cmd.open.length === 1 && cmd.open[0] === 'beta');
    report.bounds = win.getBounds();
    report.visible = win.isVisible();
    check('Verification window stayed hidden', !win.isVisible());
    if (process.env.NEKKO_CAPTURE_HOLD) await sleep(Number(process.env.NEKKO_CAPTURE_HOLD));
  } catch (error) { report.errors.push(String(error.stack || error)); }
  finally {
    report.success = report.errors.length === 0 && report.checks.every(c => c.passed);
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy();
    app.exit(base && report.errors.length === 0 ? 0 : report.success ? 0 : 1);
  }
});
