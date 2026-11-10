// The Models page's cloud providers, synthetic bridge, hidden isolated Electron window that never takes focus.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Run through layout-evidence-integration.cjs');
const before = process.env.NEKKO_TEST_LABEL === 'before';
const profile = path.join(out, 'profile');
app.disableHardwareAcceleration(); // capturePage throws UnknownVizError on GPU-less hosts otherwise
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 860, height: 1100, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -12000, y: -12000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [] };
  win.on('focus', () => report.errors.push('Unexpected window focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const check = (name, passed) => { report.checks.push({ name, passed: !!passed }); if (!passed) throw Error(name); };
  const shot = async (name) => { win.webContents.invalidate(); await sleep(150); fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1200);
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme = ${js(theme)}`);
      for (const [label, width] of [['desktop', 860], ['phone', 380]]) {
        win.setContentSize(width, 1100);
        await sleep(400);
        check(`${theme} ${label}: no horizontal overflow`, await run('document.documentElement.scrollWidth <= innerWidth'));
        await shot(`models-${theme}-${label}`);
      }
    }
    // A hidden window never finishes the theme-change colour transitions, so the interactive pass starts from a fresh load (dark by default).
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1200);
    win.setContentSize(860, 1100);
    await sleep(300);
    if (!before) {
      check('secret never rendered', await run('!document.body.innerHTML.includes("synthetic-secret-never-render")'));
      check('Claude family lists three accounts', await run('document.querySelectorAll("[data-provider-family=\\"claude\\"] [data-account-row]").length === 3'));
      check('organization and personal named', await run('document.querySelector("[data-provider-family=\\"claude\\"]").innerText.includes("Acme Inc") && document.querySelector("[data-provider-family=\\"claude\\"]").innerText.includes("Personal")'));
      check('one login row for the shared email', await run('document.querySelectorAll("[data-provider-family=\\"claude\\"] [data-login-row]").length === 1 && document.querySelector("[data-login=\\"alex@example.test\\"]").querySelectorAll("[data-account-row]").length === 2'));
      check('each account says which it is', await run('document.querySelector("[data-login]").innerText.includes("Personal plan · Max") && document.querySelector("[data-login]").innerText.includes("Organization · Team")'));
      check('family summary leaves the email to the login row', await run('!document.querySelector("[data-provider-family=\\"claude\\"] [data-family-summary]").textContent.includes("alex@example.test")'));
      check('Opus lists both subscription accounts', await run('document.querySelector("[data-family-model=\\"opus\\"]").innerText.includes("Personal · Acme Inc")'));
      check('no card inside the family', await run('!document.querySelector("[data-provider-families] .card")'));
      await run('document.querySelector("[data-account-row=\\"acme\\"] button[aria-expanded]").click()');
      await sleep(500);
      check('account details open under its row', await run('!!document.querySelector("[data-account-row=\\"acme\\"] [data-account-details]")'));
      await sleep(800);
      await shot('models-acme-open-dark');
      await run('document.querySelector("[data-account-row=\\"acme\\"] button[aria-expanded]").click()');
      await run('document.querySelector("[data-add-login-account]").click()');
      await sleep(1500);
      check('another account on the login signs in and is checked', await run('document.querySelector("[data-add-login-verdict=\\"ok\\"]")?.innerText.includes("Globex · Enterprise")'));
      await shot('models-add-account-dark');
    }
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    win.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
