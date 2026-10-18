// Evidence for the Monitors dock, the Agents header controls and the + menu.
// Isolated profile, network blocked, offscreen window; synthetic fixture only.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const version = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const dir = path.join(out, version);
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, show: false, x: -16000, y: -16000, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const checks = [];
  const check = async (name, s) => { if (!await run(s)) throw Error(name); checks.push(name); };
  const move = async (x, y) => { win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); await sleep(80); };
  const capture = async (name, rect) => fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(rect, { stayHidden: true })).toPNG());
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(1000);
    await run(`document.documentElement.dataset.theme='dark'`);
    await run('integration.dashboard()'); await sleep(800);
    await capture('wall-dark');
    await run("[...document.querySelectorAll('button')].find(b=>/Configure/.test(b.textContent)).click()"); await sleep(300);
    await capture('configure-dark');
    await run(`document.documentElement.dataset.theme='light'`); await sleep(200);
    await capture('configure-light');
    await run(`document.documentElement.dataset.theme='dark'`);
    await run("integration.route('workspace')"); await sleep(600);
    await capture('agents-header-dark', { x: 0, y: 0, width: 420, height: 120 });
    const p = await run("(()=>{const r=document.querySelector('.agent-panel-plus').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await move(600, 600); await move(p.x + 2, p.y + 2); await move(p.x, p.y); await sleep(300);
    await capture('plus-menu-dark', { x: 0, y: 0, width: 420, height: 360 });
    if (version === 'after') {
      await check('menu labels', "(()=>{const b=[...document.querySelectorAll('[data-new-agent-menu] button')];return b.length===3&&b[1].textContent==='Create or Edit Photos and Videos'&&b[2].textContent==='Terminal'})()");
      await check('controls left of plus', "(()=>{const plus=document.querySelector('.agent-panel-plus').getBoundingClientRect();const c=[...document.querySelectorAll('[data-agent-panel] button')].filter(b=>/agent list|orientation|row|column/i.test(b.getAttribute('aria-label')||''));return c.length>0&&c.every(b=>b.getBoundingClientRect().right<plus.left-40)})()");
    }
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ checks }, null, 2));
  } catch (e) { console.error(e); process.exitCode = 1; }
  app.exit(process.exitCode || 0);
});
