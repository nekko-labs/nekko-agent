// Hidden, off-screen, non-focusable sandbox: right-clicks a synthetic sidebar row and
// captures the session context menu header in light and dark themes.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const after = !process.env.NEKKO_TEST_REVISION;
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 700, height: 600, show: false, x: -16000, y: -16000, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const checks = [];
  const check = async (name, s) => { if (!await run(s)) throw Error(name); checks.push(name); };
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(1000);
    await run("integration.route('workspace')"); await sleep(600);
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(200);
      await run("(()=>{const el=document.querySelector('[data-completion-row]');const r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.x+40,clientY:r.y+r.height/2,button:2}));})()");
      await sleep(400);
      await check('menu open ' + theme, "document.body.innerText.includes('Delete permanently')");
      if (after) {
        await check('label shown ' + theme, "document.body.innerText.includes('Chat ID: existing')");
        await check('label not selectable ' + theme, "[...document.querySelectorAll('span')].some(s=>s.textContent==='Chat ID: '&&getComputedStyle(s).userSelect==='none')");
        await check('id select-all ' + theme, "[...document.querySelectorAll('span')].some(s=>s.textContent==='existing'&&getComputedStyle(s).userSelect==='all')");
      }
      fs.writeFileSync(path.join(out, `menu-${theme}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await sleep(300);
    }
    console.log(JSON.stringify({ out, checks }));
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { win.destroy(); app.quit(); }
});
