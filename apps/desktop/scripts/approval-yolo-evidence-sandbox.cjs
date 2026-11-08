// Exercise the real approval bar and YOLO dialog in an isolated hidden window.
// The fixture records decisions in memory; no bridge, network or real data.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(details.url) }));
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.on('show', () => report.errors.push('became visible'));
  const run = script => win.webContents.executeJavaScript(script, true);
  const check = async (name, expression) => { const ok = await run(expression); report.checks.push({ name, ok }); if (!ok) throw Error(name); };
  const click = text => run(`[...document.querySelectorAll('[data-approval="mcp"] button')].find(button => button.textContent === ${JSON.stringify(text)}).click()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!document.querySelector(\'[data-approval="mcp"] button\')')); i++) await sleep(100);
    await click('Always allow this tool');
    await sleep(200);
    await check('MCP-only grant does not open YOLO', `!document.getElementById('yolo-warning-title') && approvalDecisions.length === 1 && approvalDecisions[0].approved && approvalDecisions[0].scope === 'tool'`);
    await click('Allow all this session');
    await sleep(200);
    await check('session scope opens warning before deciding', `!!document.getElementById('yolo-warning-title') && approvalDecisions.length === 1`);
    const capture = path.join(out, 'approval-yolo-warning.png');
    fs.writeFileSync(capture, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(capture);
    await run(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Keep asking').click()`);
    await sleep(100);
    await check('cancel does not release an approval', `!document.getElementById('yolo-warning-title') && approvalDecisions.length === 1`);
    await click('Allow all this session');
    await sleep(100);
    await run(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Turn on No restrictions').click()`);
    await sleep(100);
    await check('confirm releases the session approval', `!document.getElementById('yolo-warning-title') && approvalDecisions.length === 2 && approvalDecisions[1].scope === 'session'`);
    await click('Always allow all');
    await sleep(100);
    await check('global scope also requires confirmation', `!!document.getElementById('yolo-warning-title') && approvalDecisions.length === 2`);
    await run(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Keep asking').click()`);
    await sleep(100);
    await check('global cancellation leaves decisions unchanged', `!document.getElementById('yolo-warning-title') && approvalDecisions.length === 2`);
    if (win.isVisible() || win.isFocused()) report.errors.push('visible or focused');
    report.success = report.errors.length === 0;
  } catch (error) { report.errors.push(String(error.stack || error)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
