// Synthetic chat-switch checks; launch through chat-switch-integration.cjs.
// Off-screen, non-focusable, its own profile, network blocked.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-switch-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UNSAFE_JS_CHAR_MAP = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\0': '\\0',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};
const escapeUnsafeJsChars = (str) => str.replace(/[<>/\\\b\f\n\r\t\0\u2028\u2029]/g, (ch) => UNSAFE_JS_CHAR_MAP[ch]);
const escapeUnsafeChars = (str) => str.replace(/[<>/\\\b\f\n\r\t\0\u2028\u2029]/g, (x) => UNSAFE_JS_CHAR_MAP[x]);

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const bounds = screen.getAllDisplays().map((display) => display.bounds);
  const win = new BrowserWindow({
    width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: Math.min(...bounds.map((b) => b.x)) - 1600, y: Math.min(...bounds.map((b) => b.y)) - 1600,
    title: 'Synthetic chat switch verification',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  // `measured` holds observations (base and head both report them); `checks` must pass.
  const report = { base, checks: [], failed: [], measured: {}, captures: [], errors: [], visuallyInspected: false };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => { if (await run(source)) report.checks.push(name); else report.failed.push(name); };
  const capture = async (name) => {
    await sleep(250);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    report.captures.push(file);
  };
  const settingsCalls = "integration.calls.filter((c) => c.method === 'settings' && c.patch && 'commandWall' in c.patch).length";
  const card = (title) => `[...document.querySelectorAll('div[role=button]')].find((c) => c.getAttribute('title')?.includes(${escapeUnsafeChars(JSON.stringify(title))}))`;
  const clickCard = async (title) => { await run(`${card(title)}.click()`); await sleep(100); };
  /** Wall saves the host saw within the 600 ms settle delay after `action`. */
  const savesAfter = async (action) => { const before = await run(settingsCalls); await action(); await sleep(1100); return (await run(settingsCalls)) - before; };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(800);

    // 1. Sidebar selection on the wall, in Grid and Focus.
    for (const mode of ['grid', 'focus']) {
      await run('integration.reset()');
      await sleep(400);
      await run(`integration.configureWall({ ...integration.state().settings.commandWall, root: { id: 's', dir: 'row', sizes: [0.5, 0.5], children: [{ id: 'p1', kind: 'chat', refId: 'existing' }, { id: 'p2', kind: 'chat', refId: 'other' }] }, hero: 'existing', layout: { ...integration.state().settings.commandWall.layout, mode: '${mode}' } })`);
      await sleep(900);
      await check(`${mode}: both chats on the wall`, "document.querySelectorAll('[data-grid-cell=\"chat:existing\"]').length === 1 && document.querySelectorAll('[data-grid-cell=\"chat:other\"]').length === 1");
      // Focus marks its hero; Grid marks the selected window instead.
      const active = `document.querySelector(${JSON.stringify(mode === 'focus' ? '[data-wall-hero]' : '[data-wall-selected]')})?.dataset.gridCell === 'chat:other'`;
      const switchSaves = await savesAfter(() => clickCard('Other conversation'));
      await check(`${mode}: selecting another chat makes it the active window`, active);
      await check(`${mode}: selecting another chat keeps one window per chat`, "document.querySelectorAll('[data-grid-cell=\"chat:other\"]').length === 1 && document.querySelectorAll('[data-grid-cell=\"chat:existing\"]').length === 1");
      const reselectSaves = await savesAfter(async () => { await clickCard('Other conversation'); await clickCard('Other conversation'); });
      await check(`${mode}: reselect keeps one window and the active window`, `document.querySelectorAll('[data-grid-cell="chat:other"]').length === 1 && ${active}`);
      report.measured[`${mode}: wall saves after a switch`] = switchSaves;
      report.measured[`${mode}: wall saves after reselecting the active chat twice`] = reselectSaves;
      if (!base) {
        if (switchSaves !== 1) report.failed.push(`${mode}: a switch saves the wall once (saw ${switchSaves})`); else report.checks.push(`${mode}: a switch saves the wall once`);
        if (reselectSaves !== 0) report.failed.push(`${mode}: reselect saves nothing (saw ${reselectSaves})`); else report.checks.push(`${mode}: reselect saves nothing`);
      }
      for (const theme of ['light', 'dark']) { await run(`document.documentElement.dataset.theme = '${theme}'`); await capture(`wall-${mode}-${theme}-1200`); }
      await run("document.documentElement.dataset.theme = 'light'");
    }

    // 2. Composer drafts across a switch (behaviour this change must keep).
    await run('integration.reset()');
    await sleep(400);
    await run("integration.route('blank')");
    await sleep(200);
    await run("seedDrafts(); switchChat('existing'); integration.route('lifecycle')");
    await sleep(700);
    await check('drafts: real editor mounted', '!!document.querySelector("[contenteditable]")');
    const typed = 'Alpha last-keystroke';
    await run(`(() => { const e = document.querySelector('[contenteditable]'); e.textContent = ${escapeUnsafeJsChars(JSON.stringify(typed))}; e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'e' })); })()`);
    await sleep(30);
    await check('drafts: not saved inside the 400 ms debounce', "loadDraft('existing').text === 'Alpha'");
    await run("switchChat('other')"); await sleep(150);
    await check('drafts: last keystroke flushed on switching away', `loadDraft('existing').text === ${JSON.stringify(typed)}`);
    const pending = "[...document.querySelectorAll('img[alt^=\"Pending attachment\"]')]";
    await check('drafts: other chat restores its own text and one image', `document.querySelector('[contenteditable]').textContent === 'Beta' && ${pending}.length === 1 && ${pending}[0].src === loadDraft('other').images[0]`);
    await run("switchChat('existing')"); await sleep(150);
    await check('drafts: duplicate images and the last keystroke come back', `document.querySelector('[contenteditable]').textContent === ${JSON.stringify(typed)} && ${pending}.length === 2 && ${pending}.every((i) => i.src === loadDraft('existing').images[0])`);
    for (const theme of ['light', 'dark']) for (const width of [1200, 400]) {
      win.setContentSize(width, 900);
      await run(`document.documentElement.dataset.theme = '${theme}'`);
      await capture(`drafts-existing-${theme}-${width}`);
    }

    if (report.errors.length || win.isFocused()) report.errors.push('Fixture focus invariant failed');
    report.success = report.failed.length === 0 && report.errors.length === 0;
  } catch (error) {
    report.errors.push(String(error && error.stack || error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, ...report, captures: report.captures.length }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
