// Hidden, isolated evidence for the paid clip picker (#2973). Launch through
// layout-evidence-integration.cjs with NEKKO_LAYOUT_FIXTURE=clip-picker-fixture.tsx
// (NEKKO_TEST_SOURCE=<base checkout> for the "before" shot).
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 680, height: 460, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') console.error('renderer:', e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const before = !!process.env.NEKKO_TEST_SOURCE;
  const shot = async name => fs.writeFileSync(path.join(out, `${name}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  const report = { checks: [], errors: [] };
  const check = async (name, expr) => { const ok = await run(expr); report.checks.push({ name, ok }); if (!ok) throw Error(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('!!document.querySelector(".question-card")')); i++) await sleep(100);
    await sleep(300);
    if (before) {
      await shot('clip-picker-before');
    } else {
      await check('suggested total', `document.querySelector('[data-clip-make]').textContent === 'Make clip · $0.80'`);
      await shot('clip-picker-after-suggested');
      // Pick a longer clip with sound: the total follows.
      await run(`document.querySelector('[data-clip-option="6 seconds"]').click()`);
      await run(`document.querySelector('[data-clip-option="With audio"]').click()`);
      await sleep(200);
      await check('live total', `document.querySelector('[data-clip-total] strong').textContent === '$2.40'`);
      await check('priced button', `document.querySelector('[data-clip-make]').textContent === 'Make clip · $2.40'`);
      await shot('clip-picker-after-changed');
    }
    if (win.isVisible()) throw Error('Fixture became visible');
  } catch (e) { report.errors.push(String(e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
