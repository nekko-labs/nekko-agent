// Run through layout-evidence-integration.cjs with late-usage-fixture.tsx.
// Synthetic bridge, isolated profile, no network, never shown or focused.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const baseline = process.env.NEKKO_LATE_USAGE_BASELINE === '1';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const win = new BrowserWindow({
    width: Number(process.env.NEKKO_LATE_USAGE_WIDTH) || 1100, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    title: 'Isolated late usage recovery verification',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const report = { baseline, checks: [], failed: [], errors: [] };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', (details) => { if (details.level === 'error') report.errors.push(details.message); });
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => { (await run(source) ? report.checks : report.failed).push(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1800);
    await check('original prompt remains visible', "document.body.innerText.includes('Check the project and explain what needs fixing.')");
    await check(baseline ? 'base reproduces empty working run' : 'accounting does not resurrect a run', baseline ? "integration.running().includes('alpha')" : 'integration.running().length === 0');
    await check(baseline ? 'base offers Stop for phantom run' : 'failed reply offers Retry rather than Stop', baseline
      ? "!!document.querySelector('button[title^=Stop]')"
      : "!document.querySelector('button[title^=Stop]') && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Retry')");
    if (!baseline) await check('provider failure remains visible', "document.body.innerText.includes(\"You've hit your usage limit.\")");
    fs.writeFileSync(path.join(out, 'reopened.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    const frames = [];
    for (let i = 0; i < 8; i++) {
      frames.push((await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
      await sleep(400);
    }
    require('./evidence-gif.cjs')(path.join(out, 'reopened-timing.gif'), frames, 40);
    await run('integration.nextTurn()');
    await sleep(200);
    await check('genuine subsequent progress still starts a run', "integration.running().includes('alpha') && integration.text() === 'A genuine new reply.'");
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
    if (win.isVisible() || win.isFocusable()) report.errors.push('Window was not isolated in the background');
  } catch (e) { report.errors.push(String(e)); }
  // Retain the exact known baseline diagnostic (#360), rather than hiding it.
  report.knownBaselineErrors = report.errors.filter(e => e === 'ResizeObserver loop completed with undelivered notifications.');
  report.unexpectedErrors = report.errors.filter(e => !report.knownBaselineErrors.includes(e));
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.NEKKO_LATE_USAGE_HOLD_MS) await sleep(Number(process.env.NEKKO_LATE_USAGE_HOLD_MS));
  app.exit(report.failed.length || report.unexpectedErrors.length ? 1 : 0);
});
