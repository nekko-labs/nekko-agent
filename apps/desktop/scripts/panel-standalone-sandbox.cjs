// Isolated, hidden real-renderer evidence for Browsers and Files without an
// agent (#2824). Run through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_FIXTURE=wall-polish-fixture.tsx NEKKO_LAYOUT_SANDBOX=panel-standalone-sandbox.cjs.
// NEKKO_BASELINE=1 captures the base revision (agent rows only) without its checks.
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
  const shot = async (name) => { await sleep(500); const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  // Frames of the thumb sliding, for a recording; a capture takes longer than a frame, so this samples.
  const frames = async (name, click) => {
    const dir = path.join(out, name); fs.mkdirSync(dir, { recursive: true });
    await run(click);
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, String(i).padStart(3, '0') + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(dir);
  };
  const pick = (label) => `document.querySelector('[data-agent-panel-shows] [role="radio"][aria-label="${label}"]').click()`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run("!!document.querySelector('[data-agent-panel]')")); i++) await sleep(200);
    await run('window.integration.reset({ folders: true })');
    for (let i = 0; i < 60 && !(await run("!!document.querySelector('[data-agent-panel-shows]')")); i++) await sleep(200);
    await sleep(600);
    await run(pick('Browsers')); await sleep(800);
    await shot('panel-browsers');
    await run(pick('Files')); await sleep(800);
    await shot('panel-files');
    if (base) {
      report.success = true;
      return;
    }
    await run(pick('Browsers')); await sleep(800);
    const sites = await run(`[...document.querySelectorAll('[data-served-site]')].map((b) => [b.dataset.servedSite, b.textContent.trim()])`);
    check('Browsers lists the served pages, tagged with their folder', JSON.stringify(sites) === JSON.stringify([['5173', 'Shop adminshop'], ['4000', 'Docs previewdocs'], ['8000', 'localhost:8000:8000']]), { sites });
    check('a blank browser is offered, and the agents sit under their heading', await run(`!!document.querySelector('[data-blank-browser]') && !!document.querySelector('[data-companion-heading] ~ div [data-companion-row="alpha"]')`), {});
    await run(`document.querySelector('[data-served-site="5173"]').click()`); await sleep(900);
    check('a page opens as a Browser window on the wall', await run(`!!document.querySelector('[data-grid-cell="browser:http://localhost:5173/"]')`), {});
    await shot('wall-browser');
    await run(pick('Files')); await sleep(800);
    const folders = await run(`[...document.querySelectorAll('[data-connected-folder]')].map((b) => [b.dataset.connectedFolder, b.textContent.trim()])`);
    check('Files lists the connected folders, the repository with its name', JSON.stringify(folders) === JSON.stringify([['ws-shop', 'shopacme/shop'], ['ws-docs', 'docs'], ['ws-notes', 'notes']]), { folders });
    await run(`document.querySelector('[data-connected-folder="ws-shop"]').click()`); await sleep(900);
    const filesWin = await run(`(() => { const w = document.querySelector('[data-grid-cell="files:C:/fixture/shop"]'); return { open: !!w, text: w ? w.textContent : '' }; })()`);
    check('a folder opens as a Files window listing it', filesWin.open && filesWin.text.includes('package.json'), filesWin);
    await shot('wall-files');
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
