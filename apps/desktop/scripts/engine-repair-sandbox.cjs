// Hidden, non-focusable, network-blocked window that captures the Model server
// card with a broken CUDA engine. Launch through engine-repair-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_COMPONENT_OUT;
if (!out) throw Error('Launch through engine-repair-integration.cjs');
const kind = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const runDir = path.join(out, kind);
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const report = { checks: [], errors: [], captures: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: `Engine repair ${kind} · isolated`, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('show', () => { report.errors.push('Verification window became visible'); });
  win.on('focus', () => { report.errors.push('Verification window took OS focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const capture = async name => { await sleep(300); const file = path.join(runDir, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(900);
    if (!await run("document.body.textContent.includes('Model server')")) throw Error('Fixture did not mount: ' + await run('document.body.textContent.slice(0,300)'));
    const hasBanner = await run("!!document.querySelector('[role=alert]') && document.body.textContent.includes('Repair engine')");
    if (kind === 'after') {
      if (!hasBanner) throw Error('Repair banner missing');
      report.checks.push('banner and Repair engine button shown for a CUDA install missing its runtime');
    } else {
      report.checks.push(`base revision banner present: ${hasBanner}`);
    }
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      for (const [width, height, label] of [[1280, 760, 'wide'], [460, 1100, 'narrow']]) {
        win.setContentSize(width, height);
        await capture(`${theme}-${label}`);
      }
    }
    if (kind === 'after') {
      await run(`document.documentElement.dataset.theme='dark'`);
      win.setContentSize(1280, 760);
      await run("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Repair engine')).click()");
      await sleep(500);
      const installs = await run('window.__installs || []');
      if (JSON.stringify(installs) !== JSON.stringify(['win-x64-cuda'])) throw Error('Repair did not reinstall the same build: ' + JSON.stringify(installs));
      report.checks.push('Repair engine reinstalls win-x64-cuda exactly once');
      await capture('dark-wide-after-click');
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused() };
    if (win.isVisible() || win.isFocused()) report.errors.push('Background verification visibility/focus invariant failed');
    report.success = !report.errors.length;
  } catch (e) { report.errors.push(String(e)); report.success = false; }
  finally { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ runDir, ...report }, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
