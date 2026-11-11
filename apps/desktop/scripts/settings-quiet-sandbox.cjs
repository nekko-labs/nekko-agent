// Every Settings group, top of group, in a hidden window: before/after evidence for quiet Settings (#2563).
// NEKKO_LAYOUT_FIXTURE=settings-customize-fixture.tsx NEKKO_LAYOUT_SANDBOX=settings-quiet-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_window, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [], checks: {} };
  const run = code => win.webContents.executeJavaScript(code, true);
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message.slice(0, 300)); });
  const shot = async name => {
    await sleep(400);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(name);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!window.settingsFixture && !!document.querySelector(".settings-nav")'); i++) await sleep(200);
    await sleep(800);
    const groups = JSON.parse(await run('JSON.stringify([...document.querySelectorAll("[data-settings-group]")].map(g => g.dataset.settingsGroup))'));
    for (const width of [1280, 600]) {
      win.setContentSize(width, 900);
      await sleep(300);
      for (const g of width === 1280 ? groups : ['general', 'safety']) {
        // Scroll the content pane, not the window: the rail stays put.
        await run(`(() => { const s = document.querySelector('.settings-content'); const t = document.getElementById('settings-${g}'); s.scrollTop += t.getBoundingClientRect().top - s.getBoundingClientRect().top; })()`);
        await shot(`${g}-${width}`);
      }
      report.checks[`overflow-${width}`] = await run('document.documentElement.scrollWidth <= innerWidth');
    }
    report.checks.cards = await run('document.querySelectorAll(".settings-page .card").length');
    report.checks.outlines = await run('document.querySelectorAll(".settings-page .btn-outline").length');
    report.checks.boxedInputs = await run('document.querySelectorAll(".settings-page .input").length');
  } catch (error) {
    report.errors.push(String(error && error.stack || error));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ errors: report.errors, checks: report.checks }));
  app.exit(report.captures.length ? 0 : 1);
});
