// Hidden, isolated full-App evidence for the YOLO warning: the Settings row
// and the dialog that opens when YOLO is chosen. No real data or network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.on('show', () => report.errors.push('became visible'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await win.capturePage(undefined, { stayHidden: true }); await sleep(200); const f = path.join(out, `${name}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const check = async (name, expression) => { const ok = await run(expression); report.checks.push({ name, ok }); if (!ok) throw Error(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => { const f = layoutFixture; f.bridge.getRemoteStatus = async () => ({ enabled: false }); f.store.setState({ view: 'settings' }); })()`);
    await sleep(1200);
    await run(`document.querySelector('[aria-label="Confirm deletions"]').closest('div').scrollIntoView({ block: 'center' })`);
    await sleep(300);
    await shot('yolo-settings-row');
    report.hasWarnToggle = await run(`!!document.querySelector('[aria-label="Warn before YOLO"]')`);
    if (report.hasWarnToggle) {
      // Choose YOLO as the default for new chats: the warning opens first.
      await run(`[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('YOLO') && b.textContent.includes('Run everything')).click()`);
      await sleep(500);
      await check('the warning opened', `!!document.getElementById('yolo-warning-title')`);
      await shot('yolo-warning-dialog');
      win.setContentSize(520, 900); await sleep(400);
      await shot('yolo-warning-dialog-narrow');
      win.setContentSize(1200, 900); await sleep(300);
      await run(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Keep asking').click()`);
      await sleep(300);
      await check('Keep asking closes it', `!document.getElementById('yolo-warning-title')`);
    }
    if (win.isVisible() || win.isFocused()) report.errors.push('visible or focused');
    report.success = report.errors.length === 0;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
