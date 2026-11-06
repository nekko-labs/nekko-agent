// The first-chat "Send your first prompt" intro, in the full App. Run through layout-evidence-integration.cjs:
//   NEKKO_LAYOUT_SANDBOX=first-prompt-intro-sandbox.cjs NEKKO_TEST_LABEL=first-prompt node apps/desktop/scripts/layout-evidence-integration.cjs
// The fixture's chats have no exchanges and its settings no firstPromptIntroSeen, so the new chat is a first ever chat.
// Hidden, off-screen, non-focusable; renderer input only. With NEKKO_TEST_SOURCE (an unchanged base tree) it
// captures the new-chat screen only, as the "before".
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: {}, errors: [] };
const before = !!process.env.NEKKO_TEST_SOURCE;
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'First prompt intro, isolated evidence', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  // A hidden window paints only when asked: invalidate and let a frame land, or the capture shows the previous state.
  const shot = async name => { for (let i = 0; i < 3; i++) { win.webContents.invalidate(); await sleep(500); await win.capturePage(undefined, { stayHidden: true }); } const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const until = async (code, what, tries = 80) => { for (let i = 0; i < tries; i++) { if (await run(code)) return; await sleep(100); } throw Error('Timed out waiting for ' + what); };
  // Calls a fixed page function with real arguments over CDP, so no value is ever spliced into code.
  const call = async (fn, ...args) => {
    const dbg = win.webContents.debugger;
    const { result: page } = await dbg.sendCommand('Runtime.evaluate', { expression: 'globalThis' });
    const { result, exceptionDetails } = await dbg.sendCommand('Runtime.callFunctionOn', { objectId: page.objectId, functionDeclaration: fn.toString(), arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const clickDialogButton = function (text) {
    const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => x.textContent.trim() === text);
    if (!b) throw Error('Missing button ' + text);
    b.click();
  };
  const button = text => call(clickDialogButton, text);
  const open = '!!document.querySelector("[data-first-prompt-intro-step]")';
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({ root: { id: 'intro-pane', kind: 'chat', refId: 'd' }, hero: 'd', watermark: 1, zonesIntro: true, autoAdd: false, layout: { mode: 'focus' }, dock: { show: false }, agentPanel: { show: false } }));` });
    await win.loadFile(path.join(out, 'index.html'));
    await until('!!document.querySelector("[data-clean-start] .clean-start")', 'the new-chat screen');
    if (before) { await sleep(1500); await shot('new-chat'); report.success = true; return; }

    // 1. It opens on its own over the first chat.
    await until(open, 'the intro to open');
    for (const [i, t] of [[1, 1200], [2, 2600], [3, 3400]]) {
      if (i > 1) await button('Next');
      await until(`document.querySelector("[data-first-prompt-intro-step]")?.dataset.firstPromptIntroStep === "${i - 1}"`, `step ${i}`);
      await sleep(t);
      await shot(`step-${i}`);
      report.checks[`step${i}`] = await run(`(() => { const d = document.querySelector('[role=dialog]'); return { title: d.querySelector('h3')?.textContent, buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim() || b.getAttribute('aria-label')).filter(Boolean) }; })()`);
    }
    // Get started closes it and saves the flag.
    await button('Get started');
    await until(`!(${open})`, 'the intro to close');
    report.checks.seenAfterGetStarted = await run('layoutFixture.bridge.getSettings().then((s) => !!s.firstPromptIntroSeen)');
    await shot('after-close');

    // 2. Skip, on a fresh start (a reload rebuilds the fixture's settings without the flag):
    //    one click on the first step closes it and saves the flag to the store.
    await win.loadFile(path.join(out, 'index.html'));
    await until(open, 'the intro to open again');
    await button('Skip');
    await until(`!(${open})`, 'Skip to close it');
    report.checks.seenAfterSkip = await run('layoutFixture.bridge.getSettings().then((s) => !!s.firstPromptIntroSeen)');
    await until('!!layoutFixture.store.getState().settings?.firstPromptIntroSeen', 'the saved flag to reach the store');

    // 3. Once seen it stays closed while the chat list and settings keep updating.
    await run('layoutFixture.store.getState().refreshSessions()');
    await sleep(2000);
    report.checks.staysClosed = !(await run(open));

    report.bounds = win.getBounds(); report.hidden = !win.isVisible(); report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    const c = report.checks;
    report.success = c.step1?.buttons.includes('Skip') && c.step3?.buttons.includes('Get started') && c.seenAfterGetStarted && c.seenAfterSkip && c.staysClosed;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'intro-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
