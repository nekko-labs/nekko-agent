const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
const report = { kind, errors: [], captures: [], metrics: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, d) => d(false));
  // Never shown: painted hidden and read with capturePage, so nothing lands on the user's screen.
  const win = new BrowserWindow({ width: 1100, height: 1900, useContentSize: true, show: false, paintWhenInitiallyHidden: true, focusable: false, skipTaskbar: true, webPreferences: { contextIsolation: true, sandbox: true, offscreen: false } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const settle = async () => { await run('document.fonts.ready'); await sleep(600); };
  const dockRect = async () => run(`(()=>{const r=document.querySelector('.monitors-dock').getBoundingClientRect();return {x:Math.floor(r.x)-12,y:0,width:Math.ceil(r.width)+12,height:Math.ceil(Math.min(innerHeight, document.querySelector('.monitors-dock__monitors').scrollHeight+60))}})()`);
  const capture = async (name) => { await settle(); await run(`scrollTo(0,0); document.querySelectorAll('*').forEach((e)=>{ if (e.scrollTop) e.scrollTop = 0; })`); const img = await win.capturePage(await dockRect(), { stayHidden: true }); fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG()); report.captures.push(name); };
  try {
    await win.loadFile(path.join(dir, 'index.html')); await settle(); await sleep(800);
    await run(`document.querySelector('.monitors-dock__toggle')?.click()`); await settle(); await sleep(800);
    report.metrics = await run(`(()=>{const d=document.querySelector('.monitors-dock');const ms=[...document.querySelectorAll('.monitors-dock__monitor')].map(m=>({key:m.dataset.monitor,h:Math.round(m.getBoundingClientRect().height)}));const b=[...document.querySelectorAll('.monitors-dock__monitor-header button, [data-runner-card] button')].map(x=>({label:x.getAttribute('aria-label')||x.innerText.trim(),border:getComputedStyle(x).borderTopWidth+' '+getComputedStyle(x).borderTopStyle,bg:getComputedStyle(x).backgroundColor}));return {stack:document.querySelector('.monitors-dock__monitors').scrollHeight,dockWidth:Math.round(d.getBoundingClientRect().width),monitors:ms,buttons:b,gfHeader:document.querySelectorAll('.monitors-dock__monitor-header [data-gf-icon]').length}})()`);
    await capture(`${kind}-dock`);
    const r = await run(`(()=>{const b=document.querySelector('.monitors-dock__monitor-header button[aria-label^="Remove"]').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
    await sleep(150); const img = await win.capturePage(await dockRect(), { stayHidden: true }); fs.writeFileSync(path.join(dir, `${kind}-hover-close.png`), img.toPNG());
  } catch (e) { report.errors.push(String(e)); }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(kind, JSON.stringify(report, null, 1)); win.destroy(); app.exit(report.errors.length ? 1 : 0); }
});
