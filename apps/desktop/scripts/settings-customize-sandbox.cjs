// Hidden Settings evidence with a disposable profile, denied network and permissions.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_window, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [], checks: {} };
  const run = code => win.webContents.executeJavaScript(code, true);
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  const shot = async name => {
    await sleep(500);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(name);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!window.settingsFixture && !!document.querySelector(".settings-nav")'); i++) await sleep(200);
    for (const width of [1280, 600]) {
      win.setContentSize(width, 900);
      await run('document.querySelector(".settings-content").scrollTop = 0');
      await shot(`general-${width}`);
      // Same Appearance card before/after; only its parent section changes.
      await run('[...document.querySelectorAll("section")].find(e => e.querySelector("h2")?.textContent === "Appearance").scrollIntoView({block:"start"})');
      await shot(`appearance-${width}`);
      await run('document.getElementById("settings-simple").scrollIntoView({block:"start"})');
      await shot(`simple-${width}`);
      report.checks[`overflow-${width}`] = await run('document.documentElement.scrollWidth <= innerWidth');
    }
    const customize = await run('!!document.getElementById("settings-customize")');
    if (customize) {
      win.setContentSize(1280, 900);
      await run('[...document.querySelectorAll(".settings-nav button")].find(e => e.textContent === "General").click()');
      await sleep(300);
      await run('[...document.querySelectorAll(".settings-nav button")].find(e => e.textContent === "Customize").click()');
      await sleep(300);
      report.checks.navigation = await run('document.querySelector(".settings-nav [aria-current=true]")?.textContent === "Customize"');
      for (const label of ['Show tips', 'Show Skills in sidebar']) {
        await run(`document.querySelector('[aria-label=' + ${js(JSON.stringify(label))} + ']').click()`);
      }
      await sleep(200);
      report.checks.saved = await run('settingsFixture.patches.some(p => p.showTips === true) && settingsFixture.patches.some(p => p.sidebarViews?.skills === true)');
      report.checks.membership = await run(`['settings-style', 'settings-accessibility', 'settings-simple', 'customization'].every(id => document.getElementById(id)?.closest('[data-settings-group]')?.dataset.settingsGroup === 'customize')`);
      report.checks.separate = await run('!!document.querySelector("[data-settings-group=system]") && !!document.querySelector("[data-settings-group=computers]")');
    }
    report.hidden = !win.isVisible();
    report.viewport = await run('({ width: innerWidth, height: innerHeight, scale: devicePixelRatio, theme: document.documentElement.dataset.theme })');
    if (!report.hidden || Object.values(report.checks).some(value => !value)) throw Error('Settings verification failed');
  } catch (error) { report.errors.push(String(error.stack || error)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.exit(report.errors.length ? 1 : 0);
});
