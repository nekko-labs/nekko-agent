// Captures model-releases(-before)-fixture.tsx: the Variants list of a repo with
// three releases, at rest and after pressing Download on the newest Q8_0.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Run through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { checks: [], captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 1300, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const wait = async (s) => { for (let i = 0; i < 80; i++) { if (await run(s)) return; await sleep(100); } throw Error(`Timed out: ${s}`); };
  const shot = async (name) => {
    const h = await run("Math.ceil(document.querySelector('h2') ? [...document.querySelectorAll('h2')].find(e=>e.textContent==='Details').getBoundingClientRect().top : 900)");
    const top = await run("Math.floor([...document.querySelectorAll('h2')].find(e=>e.textContent==='Variants').getBoundingClientRect().top) - 12");
    for (let i = 0; i < 3; i++) { win.webContents.invalidate(); await sleep(300); await win.capturePage(undefined, { stayHidden: true }); }
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage({ x: 0, y: top, width: 1100, height: h - top }, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await wait("document.body.innerText.includes('Variants')");
    await sleep(400);
    await shot('releases-rest');
    // Press Download on the first Q8_0 row: v2.1 after the change, an unnamed one of three before.
    await run("[...document.querySelectorAll('span.font-mono')].find(e=>e.textContent==='Q8_0').parentElement.querySelector('button').click()");
    await sleep(800);
    report.checks.push({ name: 'rows downloading', value: await run("[...document.querySelectorAll('button')].filter(b=>b.textContent.includes('Downloading')).length") });
    await shot('releases-downloading');
  } catch (e) { report.errors.push(String(e && e.stack || e)); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
});
