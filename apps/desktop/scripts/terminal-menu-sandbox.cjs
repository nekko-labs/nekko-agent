// Hidden, non-focusable, network-blocked check of the terminal right-click menu
// and clipboard keys. The fixture's clipboard is in memory; the OS clipboard is
// never touched.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const version = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const dir = path.join(out, version);
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 900, height: 520, show: false, x: -16000, y: -16000, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => console.log(e.message));
  const run = s => win.webContents.executeJavaScript(s, true);
  const checks = [];
  const check = async (name, s) => { if (!await run(s)) throw Error('FAILED: ' + name); checks.push(name); };
  const capture = async name => fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  const rightClick = async (x, y) => {
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x, y, button: 'right', clickCount: 1 });
    await sleep(250);
  };
  const drag = async (x1, y1, x2, y2) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: x1 + ((x2 - x1) * i) / 6, y: y1 + ((y2 - y1) * i) / 6, button: 'left' }); await sleep(30); }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 });
    await sleep(200);
  };
  // Keys go to xterm's helper textarea the way the browser delivers them.
  const key = (k, mods = {}) => run(`(()=>{const t=document.querySelector('.xterm-helper-textarea');t.focus();const e=new KeyboardEvent('keydown',{key:${JSON.stringify(k)},code:${JSON.stringify(k.length === 1 ? 'Key' + k.toUpperCase() : k)},keyCode:${k.length === 1 ? k.toUpperCase().charCodeAt(0) : 45},ctrlKey:${!!mods.ctrl},shiftKey:${!!mods.shift},bubbles:true,cancelable:true});t.dispatchEvent(e);return e.defaultPrevented})()`);
  const item = label => `[...document.querySelectorAll('[role=menu] [role=menuitem]')].find(b=>b.textContent.startsWith(${JSON.stringify(label)}))`;
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(1500);
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(300);
      await drag(14, 62, 170, 62); // select across the second output line
      await rightClick(300, 200);
      await capture(`menu-selection-${theme}`);
      await run("document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))"); await sleep(150);
    }
    await run("document.documentElement.dataset.theme='light'");
    if (version === 'after') {
      await rightClick(300, 200);
      await check('right-click opens the terminal menu', "!!document.querySelector('[role=menu]')");
      await check('menu lists Copy, Paste, Select all, Clear terminal', `(()=>{const t=[...document.querySelectorAll('[role=menu] [role=menuitem]')].map(b=>b.textContent);return ['Copy','Paste','Select all','Clear terminal'].every((l,i)=>t[i]&&t[i].startsWith(l))})()`);
      await check('Copy enabled with a selection', `!${item('Copy')}.disabled`);
      await run(`${item('Copy')}.click()`); await sleep(150);
      await check('Copy puts the selection on the clipboard', "clip.text.includes('tests passed')");
      await check('menu closes after an action', "!document.querySelector('[role=menu]')");
      await rightClick(300, 200);
      await check('Copy disabled without a selection', `${item('Copy')}.disabled`);
      await run("clip.text='pasted-from-clipboard'");
      await run(`${item('Paste')}.click()`); await sleep(200);
      await check('Paste sends clipboard text to the shell', "integration.writes.join('').includes('pasted-from-clipboard')");
      await rightClick(300, 200); await run(`${item('Select all')}.click()`); await sleep(150);
      await capture('select-all');
      await key('c', { ctrl: true }); await sleep(150);
      await check('Ctrl+C with a selection copies, sends no ^C', "clip.text.includes('npm test')&&!integration.writes.includes('\\x03')");
      await key('c', { ctrl: true }); await sleep(150);
      await check('Ctrl+C without a selection still interrupts', "integration.writes.includes('\\x03')");
      await run("clip.text='via-ctrl-v'"); const prevented = await key('v', { ctrl: true }); await sleep(200);
      await check('Ctrl+V pastes once', `${prevented}&&integration.writes.filter(w=>w.includes('via-ctrl-v')).length===1`);
      await run("clip.text='via-ctrl-shift-v'"); await key('V', { ctrl: true, shift: true }); await sleep(200);
      await check('Ctrl+Shift+V pastes', "integration.writes.some(w=>w.includes('via-ctrl-shift-v'))");
      await rightClick(300, 200); await run(`${item('Clear terminal')}.click()`); await sleep(200);
      await capture('after-clear');
      // Read the buffer back through the menu itself: Select all + Copy.
      await rightClick(300, 200); await run(`${item('Select all')}.click()`); await sleep(100);
      await rightClick(300, 200); await run(`${item('Copy')}.click()`); await sleep(150);
      await check('Clear terminal empties scrollback', "!clip.text.includes('tests passed')&&!clip.text.includes('npm test')");
      await run("clip.fail=true"); await rightClick(300, 200); await run(`${item('Paste')}.click()`); await sleep(200);
      await check('clipboard failure shows a toast', "integration.toasts().some(t=>t.kind==='error'&&/clipboard/.test(t.message))");
      await run("clip.fail=false; integration.show('agent_log')"); await sleep(800);
      await rightClick(300, 200);
      await check('read-only agent log: Paste disabled', `${item('Paste')}.disabled`);
      await capture('readonly-log-menu');
      const before = await run("integration.writes.length"); await key('v', { ctrl: true }); await sleep(150);
      await check('read-only agent log: Ctrl+V sends nothing', `integration.writes.length===${before}`);
    } else {
      await check('baseline: no terminal menu on right-click', "!document.querySelector('[role=menu]')");
    }
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ checks }, null, 2));
    console.log(JSON.stringify({ dir, checks }, null, 2));
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { win.destroy(); app.quit(); }
});
