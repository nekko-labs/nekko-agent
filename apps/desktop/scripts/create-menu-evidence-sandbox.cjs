// Capture script for layout-evidence-integration.cjs (NEKKO_LAYOUT_SANDBOX=plus-menu-evidence-sandbox.cjs):
// the standalone Create plus-menu. Works against the current worktree and against a base branch (NEKKO_TEST_SOURCE).
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 640, height: 480, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async (name, rect) => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 40 && !(await run("!!document.querySelector('.create-menu')")); i++) await sleep(100);
    await sleep(240);
    const rect = JSON.parse(await run("JSON.stringify((()=>{const m=document.querySelector('.create-menu');if(!m)return null;const r=m.getBoundingClientRect();return{x:Math.max(0,Math.round(r.left-16)),y:Math.max(0,Math.round(r.top-8)),width:Math.round(r.width+32),height:Math.round(r.height+16)};})())"));
    if (rect) await shot('plus-menu', rect);
    else report.errors.push('plus menu did not mount');
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
