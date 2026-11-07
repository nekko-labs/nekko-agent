// Isolated component evidence for the audit trail. No bridge, real data,
// network or visible window.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 820, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [], checks: {} };
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await win.capturePage(undefined, { stayHidden: true }); await sleep(200); const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1000);
    report.checks.turns = await run("document.querySelectorAll('[data-audit-turn]').length");
    report.checks.text = await run("document.querySelector('[data-audit-trail]').closest('[role=dialog]').innerText");
    await shot('audit-trail-wide');
    await run("[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Approvals')).click()");
    await sleep(200);
    report.checks.decisionsOnly = await run("[...document.querySelectorAll('[data-audit-event]')].map(e => e.dataset.auditEvent)");
    await shot('audit-trail-approvals');
    await run("[...document.querySelectorAll('button')].find(b => b.textContent === 'Everything').click()");
    win.setContentSize(560, 820); await sleep(300);
    await shot('audit-trail-narrow');
    win.setContentSize(1100, 820);
    await win.loadFile(path.join(out, 'index.html'), { query: { empty: '1' } });
    await sleep(800);
    report.checks.empty = await run("document.querySelector('[data-audit-empty]')?.textContent");
    await shot('audit-trail-incognito');
    if (win.isVisible() || win.isFocused()) report.errors.push('visible or focused');
    report.success = report.errors.length === 0 && report.checks.turns === 2;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
