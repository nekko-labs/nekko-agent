// Synthetic evidence for the host-armed PR watch chip and its Settings toggle; never connects to the user's host or profile.
// Run: NEKKO_FIXTURE=pr-autowatch-fixture.tsx NEKKO_SANDBOX=pr-autowatch-sandbox.cjs node chat-search-integration.cjs
// (NEKKO_TEST_REVISION=<rev> for "before"). Hidden, non-focusable, off-screen; no input at all.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-search-integration.cjs');
const dir = path.join(out, process.env.NEKKO_TEST_REVISION ? 'before' : 'after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 700, height: 560, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic PR watch verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], bounds: null };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message.slice(0, 300)); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('!!document.querySelector("[data-active-watch-chips] details")')); i++) await sleep(200);
    // Open the chip's details (DOM only, no input) so its explanation shows.
    await run('document.querySelector("[data-active-watch-chips] details").open = true');
    await sleep(600);
    report.bounds = win.getBounds();
    const chip = await run('document.querySelector("[data-active-watch-chips]")?.textContent || ""');
    const settings = await run('document.querySelector("[data-pr-settings]")?.textContent || ""');
    check('chip says it watches until merge-ready', /Watching until merge-ready/.test(chip));
    check('chip explains why and how to stop it', /Nekko armed this/.test(chip) && /Settings › Pull requests/.test(chip));
    check('Settings has the toggle, on by default', /Watch each PR until it is merge-ready/.test(settings)
      && await run('document.querySelector("input[aria-label=\\"Watch each PR until it is merge-ready\\"]")?.checked === true'));
    fs.writeFileSync(path.join(dir, 'pr-autowatch.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.quit();
});
