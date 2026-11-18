// Hidden, isolated evidence for a clip's watch chip (#2973): its name, its
// stage and its cancel. Launch through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_FIXTURE=clip-chip-fixture.tsx.
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
  const win = new BrowserWindow({ width: 960, height: 850, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], checks: [] };
  win.on('focus', () => report.errors.push('Sandbox took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  const check = async (name, expr) => { const ok = await run(expr); report.checks.push({ name, ok }); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('!!window.watchFixture && !!document.querySelector("[data-active-watch-chips]")')); i++) await sleep(100);
    await sleep(600);
    await run('document.querySelector("[data-active-watch-chips] summary").click()');
    await sleep(200);
    await shot('clip-chip');
    if (!process.env.NEKKO_TEST_SOURCE) {
      const chip = 'document.querySelector("[data-active-watch-chips]").innerText';
      await check('names the clip', `${chip}.includes('Making a clip')`);
      await check('shows the step', `${chip}.includes('step 3 of 20')`);
      await check('no countdown', `!${chip}.includes('left')`);
      await check('cancel names the clip', `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Cancel clip')`);
      for (const c of report.checks) if (!c.ok) report.errors.push('failed: ' + c.name);
    }
    report.visible = win.isVisible();
    if (report.visible) report.errors.push('fixture became visible');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(report.errors.length ? 1 : 0);
});
