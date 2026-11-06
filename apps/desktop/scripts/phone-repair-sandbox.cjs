const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1000, height: 1050, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !await run("document.body.innerText.includes('Philip’s iPhone')"); i++) await sleep(100);
    await sleep(500);
    await shot('settings-desktop');
    await win.setContentSize(390, 1100);
    await sleep(250);
    await shot('settings-narrow');
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal overflow');
    report.checks.push('narrow settings fit viewport');
    if (await run("!!Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Re-pair')")) {
      await win.setContentSize(1000, 1050);
      await run("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Re-pair').click()");
      await sleep(700);
      assert.equal(await run("phoneRepairFixture.calls.join(',')"), 'pair');
      assert.equal(await run("!!document.querySelector('img[alt=\"Pairing QR\"]')"), true);
      report.checks.push('existing phone Re-pair opens a fresh QR without revoke');
      await shot('repair-qr');
      await run("(() => { const input = document.querySelector('#computer-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Studio Mac'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await run("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save name').click()");
      await sleep(200);
      assert.equal(await run('phoneRepairFixture.settings.machineName'), 'Studio Mac');
      report.checks.push('computer name saved through settings bridge');
      await shot('renamed');
    }
    report.hidden = !win.isVisible();
    report.bounds = win.getBounds();
    assert.equal(report.hidden, true);
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
