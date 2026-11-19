// Hidden, isolated evidence for the Budget panel's Paid pictures row (#2973). Launch through
// layout-evidence-integration.cjs with NEKKO_LAYOUT_FIXTURE=budget-pictures-fixture.tsx
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
  const win = new BrowserWindow({ width: 520, height: 900, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') console.error('renderer:', e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const before = !!process.env.NEKKO_TEST_SOURCE;
  const report = { checks: [], errors: [] };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('!!document.querySelector(".monitors-dock__budget")')); i++) await sleep(100);
    await run("[...document.querySelectorAll('.monitors-dock__budget button')].find(b => b.textContent.trim() === 'today')?.click()");
    await sleep(300);
    const row = await run("document.querySelector('.monitors-dock__budget [data-row=\"pictures\"]')?.textContent ?? null");
    report.checks.push({ row });
    // The panel scrolls inside: bring the breakdown (the pictures row, or where it would be) into view.
    await run(`(document.querySelector('.monitors-dock__budget [data-row="pictures"]') || document.querySelector('.monitors-dock__budget [data-row="subscription"]')).scrollIntoView({ block: 'center' })`);
    await sleep(200);
    if (!before && !(row && row.includes('Paid pictures') && row.includes('$0.07') && row.includes('2 pictures'))) throw Error(`Paid pictures row: ${row}`);
    fs.writeFileSync(path.join(out, `budget-pictures-${before ? 'before' : 'after'}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    if (win.isVisible()) throw Error('Fixture became visible');
  } catch (e) { report.errors.push(String(e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
