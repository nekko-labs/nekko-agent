// Isolated, hidden real-renderer evidence for the Agents panel's Files view as a
// file browser (no Browsers segment, no "Beside an agent" rows). Run through
// layout-evidence-integration.cjs with NEKKO_LAYOUT_FIXTURE=wall-polish-fixture.tsx
// NEKKO_LAYOUT_SANDBOX=file-browser-sandbox.cjs. NEKKO_BASELINE=1 (with
// NEKKO_TEST_SOURCE at the base revision) captures the before shots without checks.
// NEKKO_FOLDER_CONTROLS=before|after captures matching populated and empty views
// at desktop and narrow widths; after also checks the folder actions.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const base = process.env.NEKKO_BASELINE === '1';
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { checks: [], captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const check = (name, ok, facts) => { report.checks.push({ name, ok, facts }); if (!ok) throw Error('Check failed: ' + name + ' ' + JSON.stringify(facts)); };
  // A hidden window hands back an older frame: invalidate and capture until it has caught up.
  const shot = async (name) => { for (let i = 0; i < 2; i++) { await sleep(400); win.webContents.invalidate(); await win.capturePage(undefined, { stayHidden: true }); } await sleep(300); const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const pick = (label) => `document.querySelector('[data-agent-panel-shows] [role="radio"][aria-label="${label}"]').click()`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    // A hidden window delivers no frames, so a transition would be captured at its first frame: settle everything at its end state.
    await win.webContents.insertCSS('*, *::before, *::after { transition: none !important; animation: none !important; }');
    for (let i = 0; i < 60 && !(await run("!!document.querySelector('[data-agent-panel]')")); i++) await sleep(200);
    const folderControls = process.env.NEKKO_FOLDER_CONTROLS;
    if (folderControls) {
      const add = `[...document.querySelectorAll('[data-file-browser] button')].find(b => b.textContent.trim() === 'Add folder…')`;
      const remove = (name) => `document.querySelector('[aria-label="Disconnect ${name}"]')`;
      const waitFor = async (name, expression) => {
        let ok = false;
        for (let i = 0; i < 40 && !(ok = await run(expression)); i++) await sleep(50);
        check(name, ok, {});
      };
      for (const [width, height] of [[1200, 800], [390, 700]]) {
        win.setContentSize(width, height);
        for (const folders of [true, false]) {
          await run(`window.integration.reset({ empty: true, folders: ${folders} })`);
          await sleep(500);
          if (width < 768) await run(`document.querySelector('[aria-label="Open agent list"]').click()`);
          await run(pick('Files'));
          check('Files sidebar populated as requested', await run(`document.querySelectorAll('[data-connected-folder]').length === ${folders ? 3 : 0}`));
          await shot(`folders-${width}-${folders ? 'populated' : 'empty'}-${folderControls}`);
          if (folderControls !== 'after') continue;
          await waitFor('Add folder is last', `${add} === document.querySelector('[data-file-browser]').lastElementChild`);
          await run(`(${add}).click()`);
          await waitFor('cancelling the picker does not add a folder', `window.integration.calls.filter(c => c.method === 'pickFolder').length === 1 && !window.integration.calls.some(c => c.method === 'addFolder') && !(${add}).hasAttribute('aria-disabled')`);
          await run(`window.integration.setFolderPicker('C:/fixture/additional'); (${add}).click()`);
          await waitFor('connect adds a folder without changing the active chat or project', `!!document.querySelector('[data-connected-folder="ws-added"]') && document.querySelectorAll('[data-connected-folder]').length === ${folders ? 4 : 1} && window.integration.state().activeProjectId === null && !window.integration.records().some(s => s.workspaceId)`);
          const target = folders ? 'shop' : 'additional';
          const id = folders ? 'ws-shop' : 'ws-added';
          await run(`window.integration.blockFolder('${id}'); ${remove(target)}.click()`);
          await waitFor('a refused disconnect keeps the row and explains the error', `!!${remove(target)} && window.integration.state().toasts.some(t => t.kind === 'error' && t.message.includes('Wait for chats using this folder'))`);
          await run(`window.integration.blockFolder(null); ${remove(target)}.focus(); ${remove(target)}.click()`);
          await waitFor('disconnect affects only the target and keeps the Files view open', `!${remove(target)} && document.querySelectorAll('[data-connected-folder]').length === ${folders ? 3 : 0} && !document.querySelector('[data-folder-tree]') && window.integration.calls.filter(c => c.method === 'removeFolder').every(c => c.id === '${id}')`);
          await waitFor('focus returns to Add folder', `document.activeElement === (${add})`);
        }
      }
      check('hidden and non-focusable, with no renderer errors', !win.isVisible() && !win.isFocusable() && report.errors.length === 0, report.errors);
      report.success = true;
      return;
    }
    await run('window.integration.reset({ folders: true })');
    for (let i = 0; i < 60 && !(await run("!!document.querySelector('[data-agent-panel-shows]')")); i++) await sleep(200);
    await sleep(800);
    await shot('panel-agents');
    await run(pick('Files')); await sleep(800);
    await shot('panel-files');
    if (base) {
      await run(pick('Browsers')); await sleep(800);
      await shot('panel-browsers');
      report.success = true;
      return;
    }
    const segs = await run(`[...document.querySelectorAll('[data-agent-panel-shows] [role="radio"]')].map((b) => b.getAttribute('aria-label'))`);
    check('four segments, no Browsers', JSON.stringify(segs) === JSON.stringify(['Agents', 'Terminals', 'Photos and videos', 'Files']), { segs });
    check('no agent rows under Files', await run(`!document.querySelector('[data-companion-row], [data-companion-heading]')`), {});
    await run(`document.querySelector('[data-connected-folder="ws-shop"]').click()`); await sleep(800);
    const tree = await run(`[...document.querySelectorAll('[data-folder-tree="ws-shop"] button')].map((b) => b.textContent.trim())`);
    check('a folder opens in place as a tree', tree.some((t) => t.endsWith('README.md')) && tree.some((t) => t.endsWith('src')), { tree });
    await shot('panel-files-tree');
    // The folder's own package.json (the fixture lists the same names in every folder, so open it before src unfolds).
    await run(`[...document.querySelectorAll('[data-folder-tree="ws-shop"] button')].find((b) => b.textContent.trim().endsWith('package.json')).click()`); await sleep(1200);
    await run(`[...document.querySelectorAll('[data-folder-tree="ws-shop"] button')].find((b) => b.textContent.trim().endsWith('src')).click()`); await sleep(600);
    const opened = await run(`(() => {
      const cell = document.querySelector('[data-grid-cell="file:C:/fixture/shop/package.json"]');
      const ta = cell && cell.querySelector('textarea');
      const row = document.querySelector('[data-open-file="C:/fixture/shop/package.json"]');
      return { cell: !!cell, editable: !!ta && !ta.readOnly, label: ta && ta.getAttribute('aria-label'), text: ta ? ta.value.slice(0, 5) : '', row: !!row, current: row && row.getAttribute('aria-current') };
    })()`);
    check('a file opens as an editable window on the wall', opened.cell && opened.editable && opened.text.startsWith('{') && opened.label === 'Edit package.json', opened);
    check('the open file is listed at the top, marked current', opened.row && opened.current === 'true', opened);
    await shot('wall-file');
    report.success = true;
  } catch (error) {
    report.success = false;
    report.errors.push(String(error && error.stack || error));
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, success: report.success, checks: report.checks.map((c) => `${c.ok ? 'ok ' : 'NO '} ${c.name}`), errors: report.errors.slice(0, 5) }, null, 2));
    win.destroy();
    app.exit(report.success ? 0 : 1);
  }
});
