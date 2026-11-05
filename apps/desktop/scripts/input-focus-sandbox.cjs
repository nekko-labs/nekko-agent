// Run with layout-evidence-integration.cjs, NEKKO_LAYOUT_FIXTURE=input-focus-fixture.tsx
// and NEKKO_LAYOUT_SANDBOX=input-focus-sandbox.cjs. Before mode records the bug;
// the default mode fails if any focus, selection or keyboard regression returns.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
const profile = path.join(out, 'profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const baseline = process.env.NEKKO_FOCUS_BASELINE === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { baseline, checks: [], captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(details.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const displays = screen.getAllDisplays();
  const win = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: Math.min(...displays.map(d => d.bounds.x)) - 4000, y: Math.min(...displays.map(d => d.bounds.y)) - 4000,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Sandbox took OS focus'));
  win.on('show', () => report.errors.push('Sandbox became visible'));
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = (name, actual, expected = true) => { assert.deepEqual(actual, expected, name); report.checks.push(name); };
  const editor = '[contenteditable]';
  const card = '[aria-label="The agent is asking a question"]';
  const shot = async name => {
    await run('inputFocusFixture.diagnose()');
    await win.capturePage(undefined, { stayHidden: true }); await sleep(100);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file);
  };
  const show = async (kind, compact = false, id = 'question-1') => { await run(`inputFocusFixture.show(${JSON.stringify(kind)}, ${compact}, ${JSON.stringify(id)})`); await sleep(150); };
  const focus = async selector => run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.setSelectionRange(5, 7); })()`);
  const state = async selector => run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return { focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd }; })()`);
  const click = async text => { await run(`Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === ${JSON.stringify(text)}).click()`); await sleep(100); };
  const key = async value => {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: value === 'Tab' ? 9 : value === 'Enter' ? 13 : 0 });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value, windowsVirtualKeyCode: value === 'Tab' ? 9 : value === 'Enter' ? 13 : 0 });
    await sleep(80);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.webContents.debugger.attach('1.3');
    for (let i = 0; i < 50 && !(await run(`!!document.querySelector('${editor}')`)); i++) await sleep(100);
    // DOM readiness precedes the compositor's first surface in a hidden window.
    await sleep(500);
    const frames = [];
    const record = async () => { await run('inputFocusFixture.diagnose()'); for (let i = 0; i < 4; i++) { frames.push((await win.capturePage(undefined, { stayHidden: true })).toPNG()); await sleep(180); } };
    await focus(editor); await record(); await show('question');
    report.arrival = await state(editor);
    await shot('question-arrival-1100');
    await record(); await win.webContents.insertText('still typing'); await record();
    const motion = path.join(out, 'question-arrival-motion.gif');
    require('./evidence-gif.cjs')(motion, frames, 18);
    report.captures.push(motion);
    if (baseline) {
      check('Base revision reproduces the focus theft', report.arrival.focused, false);
      check('Question card took focus', await run(`document.activeElement === document.querySelector('${card}')`));
    } else {
      check('Incoming question preserves composer focus and selected range', report.arrival, { focused: true, start: 5, end: 7 });
      for (const width of [1100, 390]) {
        win.setContentSize(width, 760); await sleep(150);
        for (const target of [editor, '#search', '#notes']) {
          for (const compact of [false, true]) {
            await show(null); await focus(target); await show('question', compact);
            check(`${width}px ${target}: ${compact ? 'compact' : 'full'} question preserves selection`, await state(target), { focused: true, start: 5, end: 7 });
            await show('question', compact, 'replacement');
            check(`${width}px ${target}: replacement question preserves selection`, await state(target), { focused: true, start: 5, end: 7 });
          }
          await show('approval');
          check(`${width}px ${target}: approval preserves selection`, await state(target), { focused: true, start: 5, end: 7 });
        }
        await show('question'); await focus(editor);
        await win.webContents.insertText('still typing'); await sleep(100);
        check(`${width}px continued typing reaches composer`, await run(`document.querySelector('${editor}').value.includes('still typing')`));
        check(`${width}px typing did not answer or approve anything`, await run('inputFocusFixture.answers.length + inputFocusFixture.decisions.length'), 0);
        await shot('continued-typing-' + width);
      }
      win.setContentSize(1100, 760); await show(null); await show('question');
      await run(`document.querySelector('${editor}').focus()`);
      await key('Tab');
      check('Tab deliberately enters the question card', await run(`document.activeElement === document.querySelector('${card}')`));
      await key('2'); await key('Enter');
      check('Keyboard choice advances and keeps focus in the question card', await run(`document.activeElement === document.querySelector('${card}') && document.querySelector('${card}').textContent.includes('Which checks should I run?')`));
      await key('1'); await key('2'); await key('Enter');
      check('Keyboard answers preserve single and multiple selections', await run('inputFocusFixture.answers[0]'), [{ questionId: 'scope', labels: ['Whole app'], note: undefined }, { questionId: 'tests', labels: ['Unit tests', 'Interaction tests'], note: undefined }]);
      await click('Back');
      check('Back navigation returns to the first question', await run(`document.querySelector('${card}').textContent.includes('Which part should I update?')`));
      await click('Something else');
      check('Explicit free-text action focuses its field', await run('document.activeElement.getAttribute("aria-label")'), 'Something else');
      await win.webContents.insertText('Only the composer'); await key('Enter');
      check('Free-text next step keeps keyboard ownership', await run(`document.activeElement === document.querySelector('${card}')`));
      await key('Backspace');
      check('Returning to a saved free-text answer remains editable', await run('document.activeElement.value'), 'Only the composer');
      // A programmatic step update must not pull focus back from another field.
      await focus('#search'); await click('Next');
      check('Step navigation outside the card preserves another focused input', await state('#search'), { focused: true, start: 5, end: 7 });
      await show('approval');
      await run("document.querySelector('[role=alertdialog] button').focus()"); await key('y');
      check('Explicit approval keyboard shortcut still works', await run('inputFocusFixture.decisions'), [true]);
    }
    // Reload the same synthetic data for matched dark/light, wide/narrow shots.
    for (const width of [1100, 390]) for (const theme of ['dark', 'light']) {
      win.setContentSize(width, 760);
      await win.loadFile(path.join(out, 'index.html'));
      for (let i = 0; i < 50 && !(await run(`!!document.querySelector('${editor}')`)); i++) await sleep(100);
      await run(`document.documentElement.dataset.theme = '${theme}'`);
      await focus(editor); await show('question');
      check(`${theme} ${width}px focus matches ${baseline ? 'reproduced bug' : 'fixed behavior'}`, (await state(editor)).focused, !baseline);
      await shot(`${baseline ? 'before' : 'after'}-${theme}-${width}`);
    }
    if (process.env.NEKKO_FOCUS_HOLD_MS) await sleep(Number(process.env.NEKKO_FOCUS_HOLD_MS));
    report.hidden = !win.isVisible(); report.focused = win.isFocused(); report.bounds = win.getBounds();
    check('Sandbox remained hidden and unfocused', report.hidden && !report.focused);
    check('No renderer or isolation errors', report.errors, []);
    report.success = true;
  } catch (error) { report.errors.push(String(error.stack || error)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy();
    // The integration runner removes the profile after Electron releases its locks.
    app.exit(report.success ? 0 : 1);
  }
});
