const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'); const path = require('node:path');
const dir = process.env.NEKKO_RAIL_DIR;
if (!dir || !dir.includes('.shots')) throw Error('Isolated profile required');
app.setPath('userData', path.join(dir, `profile-${Date.now()}`)); app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !d.url.startsWith('file:') }));
  const win = new BrowserWindow({ width: 1100, height: 1000, useContentSize: true, show: false, title: 'Nekko upper rail (isolated)', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(dir, 'index.html')); win.showInactive(); const report = [];
  for (const height of [1000, 1400, 600]) for (const theme of ['dark', 'light']) {
    win.setContentSize(1100, height);
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme='${theme}'`); await sleep(250);
    report.push(await win.webContents.executeJavaScript(`(() => {const r=document.querySelector('.rail'), b=[...r.querySelectorAll('button')], first=b[0].getBoundingClientRect(),last=b.at(-1).getBoundingClientRect(); return {height:innerHeight,theme:document.documentElement.dataset.theme,first:first.top,last:last.bottom,scrollHeight:r.scrollHeight,clientHeight:r.clientHeight,center:(first.top+last.bottom)/2,bandCenter:(() => {const g=r.querySelector('.rail-group');if(!g)return null;const box=g.getBoundingClientRect(),style=getComputedStyle(g,'::before');return box.top+parseFloat(style.top)+parseFloat(style.height)/2;})()};})()`));
    fs.writeFileSync(path.join(dir, `rail-${height}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  }
  win.setContentSize(1100, 1000); win.showInactive();
  fs.writeFileSync(path.join(dir, 'geometry.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  await sleep(120000); win.destroy(); app.exit();
}).catch(e => { console.error(e); app.exit(1); });
