// Run with layout-evidence-integration.cjs; NEKKO_TEST_SOURCE selects the revision.
// Isolated profile, synthetic bridge, blocked network, hidden off-screen Electron.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, x: left - 3000, y: -2000, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], bounds: win.getBounds() };
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = code => win.webContents.executeJavaScript(code, true);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => {
      window.serviceEvidence = { calls: [], patches: [] };
      window.nekkoChrome.serviceControl = async action => { serviceEvidence.calls.push(action); return { agentRunning: true, modelRunning: false, modelAvailable: false }; };
      const bridge = layoutFixture.bridge;
      const save = bridge.updateSettings;
      bridge.updateSettings = async patch => { serviceEvidence.patches.push(patch); return save(patch); };
      bridge.checkForUpdates = async () => ({ state: 'available', currentVersion: '1', version: '2', notesUrl: '', edition: 'desktop' });
      bridge.downloadUpdate = async () => ({ state: 'downloaded', currentVersion: '1', version: '2', notesUrl: '', edition: 'desktop' });
      bridge.quitAndInstall = async () => { serviceEvidence.calls.push('install'); };
      layoutFixture.store.getState().setView('settings');
    })()`);
    await sleep(1200);
    await run("document.getElementById('settings-system').scrollIntoView({block:'start'})");
    await sleep(500);
    report.text = await run("document.getElementById('settings-system').innerText");
    fs.writeFileSync(path.join(out, 'settings-system.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    if (await run("!!document.querySelector('[aria-label=\"Nekko Agent service\"]')")) {
      const click = text => run(`Array.from(document.querySelector('[aria-label="Nekko Agent service"]').querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
      await run("document.querySelector('[aria-label=\"Nekko Agent service\"] input').click()"); await sleep(200);
      await click('Restart service'); await sleep(200);
      fs.writeFileSync(path.join(out, 'settings-system-restart-confirm.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
      report.restartBeforeConfirm = await run("serviceEvidence.calls.filter(x => x === 'restart').length");
      await click('Confirm restart'); await sleep(200);
      await click('Check for updates'); await sleep(800);
      await click('Download update'); await sleep(200);
      await click('Install update'); await sleep(200);
      fs.writeFileSync(path.join(out, 'settings-system-install-confirm.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
      report.installBeforeConfirm = await run("serviceEvidence.calls.filter(x => x === 'install').length");
      await click('Confirm install'); await sleep(200);
      report.interactions = await run('JSON.stringify(serviceEvidence)');
      const evidence = JSON.parse(report.interactions);
      if (report.restartBeforeConfirm || report.installBeforeConfirm || !evidence.calls.includes('restart') || !evidence.calls.includes('install') || !evidence.patches.some(p => p.manageServiceFromPhone === true)) throw Error('Interaction checks failed');
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
