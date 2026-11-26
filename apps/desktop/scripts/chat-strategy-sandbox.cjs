// Isolated full-ChatPane evidence. No host, network, or user's app data.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Chat strategy isolated verification', width: process.env.NEKKO_STRATEGY_NARROW ? 460 : 1050, height: process.env.NEKKO_STRATEGY_NARROW ? 1100 : 960, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [] };
  win.on('show', () => report.errors.push('Window was shown'));
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = code => win.webContents.executeJavaScript(code, true);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await run('layoutFixture.showStrategy()');
    for (let i = 0; i < 50 && !await run(`document.body.innerText.includes('Read the project brief.')`); i++) await sleep(100);
    const strategies = await run(`Array.from(document.querySelectorAll('section[aria-label="Strategy"]')).map(e => e.innerText.split(String.fromCharCode(10)).filter(Boolean).join(String.fromCharCode(10)))`);
    assert.deepEqual(strategies, process.env.NEKKO_BEFORE === '1' ? [] : ['Strategy\nTool list · Direct · No coordination needed', 'Strategy\nCode mode · Orchestration · Coordination requested']);
    report.checks.push({ strategies });
    assert(await run('document.documentElement.scrollWidth <= innerWidth'));
    assert(await run(`document.body.innerText.includes('The two ledgers agree with the audit totals.')`));
    const file = path.join(out, 'chat-strategy.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'strategy-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
