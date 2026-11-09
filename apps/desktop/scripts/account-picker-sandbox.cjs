// Real ModelPicker, synthetic bridge, hidden isolated Electron window that never takes focus.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Run through layout-evidence-integration.cjs');
const before = process.env.NEKKO_TEST_LABEL === 'before';
const profile = path.join(out, 'profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 900, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -12000, y: -12000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [] };
  win.on('focus', () => report.errors.push('Unexpected window focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const check = (name, passed) => { report.checks.push({ name, passed: !!passed }); if (!passed) throw Error(name); };
  const shot = async (name) => { win.webContents.invalidate(); await sleep(150); fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(900);
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme = ${js(theme)}`);
      for (const [label, width] of [['desktop', 900], ['phone', 380]]) {
        win.setContentSize(width, 760);
        await sleep(350);
        check(`${theme} ${label}: no horizontal overflow`, await run('document.documentElement.scrollWidth <= innerWidth'));
        await shot(`picker-${theme}-${label}`);
      }
    }
    // A hidden window never finishes the theme-change colour transitions, so the interactive pass starts from a fresh load (dark by default).
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1200);
    win.setContentSize(900, 760);
    await sleep(300);
    if (!before) {
      check('secret never rendered', await run('!document.body.innerHTML.includes("synthetic-secret-never-render")'));
      check('personal and organization named', await run('document.body.innerText.includes("Personal") && document.body.innerText.includes("Acme Inc")'));
      check('shared login email shown once in the Claude group', await run('[...document.querySelectorAll("[data-provider-group=\\"claude\\"] [data-account-email]")].length === 1'));
      check('chip names the account', await run('document.querySelector("[data-model-chip-account]")?.textContent === "Personal"'));
      // One click on the organization tab moves the chat to the same model there.
      await run('[...document.querySelectorAll("[role=radio]")].find((b) => b.textContent.includes("Acme Inc")).click()');
      await sleep(300);
      check('account tab switches the chat to the same model', await run('JSON.stringify(window.integration.selection()) === JSON.stringify({ providerId: "acme", modelId: "opus" })'));
      check('picker closes after the switch', await run('!document.querySelector("[data-model-picker]")'));
      check('chip now names the organization', await run('document.querySelector("[data-model-chip-account]")?.textContent === "Acme Inc"'));
      await shot('chip-after-switch');
      await run('window.integration.open()');
      await sleep(400);
      await shot('picker-acme-dark-desktop');
      // An account without the chat's model only shows its models; nothing changes until a model is picked.
      const callsBefore = await run('window.integration.calls.length');
      await run('[...document.querySelectorAll("[role=radio]")].find((b) => b.textContent.includes("Production")).click()');
      await sleep(300);
      check('account without the model does not move the chat', await run(`window.integration.calls.length === ${callsBefore}`));
      check('its models are listed', await run('document.body.innerText.includes("Claude Opus 4.7")'));
      await shot('picker-api-dark-desktop');
      // Search spans every account and names each row's account.
      const input = await run('!!document.querySelector("[aria-label=\\"Filter models\\"]")');
      if (input) {
        await win.webContents.debugger.attach('1.3');
        await run('document.querySelector("[aria-label=\\"Filter models\\"]").focus()');
        await win.webContents.debugger.sendCommand('Input.insertText', { text: 'opus' });
        await sleep(300);
        check('search lists the model on every account', await run('[...document.querySelectorAll("[data-model-row]")].length >= 3'));
        await shot('picker-search-dark-desktop');
        win.webContents.debugger.detach();
      }
    }
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    win.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
