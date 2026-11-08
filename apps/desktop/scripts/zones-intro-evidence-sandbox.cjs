// A fresh install (onboarding-evidence-fixture.tsx): skip setup, look for the
// zones tour, then pick Multi-agent in the View menu and look again. Hidden,
// non-focusable, network-blocked window; stub bridge, no real data.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const label = process.env.NEKKO_TEST_LABEL || 'head';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [], checks: {} };
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await sleep(400); const f = path.join(out, `${name}-${label}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const tour = () => run("document.body.innerText.includes('Agents now live in zones')");
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.webContents.debugger.attach();
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (let i = 0; i < 100 && !(await run("!!document.querySelector('[role=dialog]')")); i++) await sleep(100);
    await run("[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Skip setup').click()");
    await sleep(2500);
    report.checks.tourAtLaunch = await tour();
    await shot('1-after-setup');
    await run("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('View')).click()");
    await sleep(400);
    report.checks.menuOpen = await run("!!document.querySelector('[data-view-mode=grid]')");
    await run("document.querySelector('[data-view-mode=grid]').click()");
    await sleep(1500);
    report.checks.tourAfterMultiAgent = await tour();
    await shot('2-picked-multi-agent');
    if (win.isVisible() || win.isFocused()) report.errors.push('visible or focused');
    report.success = report.errors.length === 0 && report.checks.menuOpen;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.checks)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
