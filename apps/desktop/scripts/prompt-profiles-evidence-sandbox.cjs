// Capture the System prompt size Settings section in an isolated hidden window.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  const win = new BrowserWindow({ width: 800, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  let code = 0;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(800);
    await run(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent === 'Small').click()`);
    await sleep(300);
    fs.writeFileSync(path.join(out, 'prompt-profiles-settings.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  } catch (e) { console.error(e); code = 1; }
  win.destroy(); app.exit(code);
});
