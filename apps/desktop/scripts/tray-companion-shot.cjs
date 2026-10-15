// Electron: renders the tray companion's first-close guidance exactly as the
// app loads it (a data: URL in a 340x180 frameless window), hidden and
// unfocusable on a throwaway profile, then reports overflow and captures it.
// Usage: electron tray-companion-shot.cjs <companion.cjs> <out.png>
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const [companion, outPng] = process.argv.slice(-2);
app.setPath('userData', path.join(path.dirname(outPng), 'tip-profile'));
app.whenReady().then(async () => {
  const b = screen.getAllDisplays().map(d => d.bounds);
  const win = new BrowserWindow({ width: 340, height: +(process.env.TIP_H || 150), x: Math.min(...b.map(v => v.x)) - 800, y: Math.min(...b.map(v => v.y)) - 800, show: false, focusable: false, skipTaskbar: true, frame: false, resizable: false, backgroundColor: '#101714', title: 'Synthetic tray companion verification', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let code = 0;
  try {
    const { companionHtml } = require(companion);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(companionHtml(true, true, true)));
    win.showInactive();
    await new Promise(r => setTimeout(r, 600));
    const facts = await win.webContents.executeJavaScript(`({ scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight, bodyScrollH: document.body.scrollHeight, bodyClientH: document.body.clientHeight, links: [...document.querySelectorAll('nav a')].map(a => ({ text: a.textContent, h: Math.round(a.getBoundingClientRect().height), bottom: Math.round(a.getBoundingClientRect().bottom) })), close: !!document.querySelector('[aria-label="Dismiss"]'), settings: document.body.textContent.includes('Settings') })`, true);
    console.log(JSON.stringify(facts));
    fs.writeFileSync(outPng, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  } catch (e) { console.error(String(e && e.stack || e)); code = 1; }
  win.destroy();
  app.exit(code);
});
