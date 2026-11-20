// Isolated, hidden real-renderer evidence for the Agents panel's Files view as a
// file browser (no Browsers segment, no "Beside an agent" rows). Run through
// layout-evidence-integration.cjs with NEKKO_LAYOUT_FIXTURE=wall-polish-fixture.tsx
// NEKKO_LAYOUT_SANDBOX=file-browser-sandbox.cjs. NEKKO_BASELINE=1 (with
// NEKKO_TEST_SOURCE at the base revision) captures the before shots without checks.
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
    app.quit();
  }
});
