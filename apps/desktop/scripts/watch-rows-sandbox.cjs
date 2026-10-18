const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.NEKKO_WATCH_ROWS_DIR;
if (!dir) throw Error('Launch through watch-rows-integration.cjs');
app.setPath('userData', path.join(dir, 'profile'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { captures: [], errors: [], dotWidths: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  const win = new BrowserWindow({ width: 960, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'Watch rows · isolated', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { await sleep(300); const f = path.join(dir, `${name}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(dir, 'index.html')); await sleep(700);
    // Open the subagent group, as in the reported screenshot.
    for (let i = 0; i < 5 && !(await run("document.querySelector('#subagents button[aria-expanded]')?.getAttribute('aria-expanded') === 'true'")); i++) {
      await run("document.querySelector('#subagents button[aria-expanded]')?.click()");
      await sleep(250);
    }
    if (!(await run("document.querySelectorAll('#subagents li').length === 4"))) report.errors.push('Subagent group did not expand');
    await shot('dark');
    // Measure the text after the dots across a full animation cycle: it must not move.
    for (let i = 0; i < 8; i++) {
      report.dotWidths.push(await run("(() => { const d = document.querySelector('#subagents .dots'); const t = d && (d.nextElementSibling || d.previousElementSibling); return d ? [Math.round(d.getBoundingClientRect().width*10)/10, Math.round(t.getBoundingClientRect().left*10)/10] : null; })()"));
      await sleep(180);
    }
    await run("document.documentElement.dataset.theme='light'");
    await shot('light');
    win.setContentSize(440, 900);
    await shot('light-narrow');
    // The first frame can race the expand; take the dark view again once settled.
    win.setContentSize(960, 900);
    await run("document.documentElement.dataset.theme='dark'");
    await shot('dark');
  } catch (e) { report.errors.push(String(e)); }
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(0);
});
