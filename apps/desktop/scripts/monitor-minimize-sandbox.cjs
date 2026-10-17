// Hidden, non-focusable, off-screen window with its own profile and no network.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT, shots = process.env.NEKKO_SHOTS_OUT, base = !!process.env.NEKKO_TEST_REVISION;
const tag = base ? 'before' : 'after';
app.setPath('userData', path.join(out, 'profile')); app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({ width: 1000, height: 360, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { tag, checks: [], errors: [] };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const rect = (sel) => `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}})()`;
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(800);
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      for (const state of ['minimized', 'open']) {
        await run(`integration.setOpen(${state === 'open'})`); await sleep(350);
        const toggle = await run(rect('[data-plan-toggle]')), msg = await run(rect('.msg-user'));
        const overlap = !!(toggle && msg && toggle.left < msg.right && toggle.right > msg.left && toggle.top < msg.bottom && toggle.bottom > msg.top);
        const header = await run("(()=>{const h=document.querySelector('aside header');if(!h)return null;return [...h.children].map(c=>c.getAttribute('aria-label')||c.textContent||c.tagName)})()");
        report.checks.push({ name: `${theme} ${state}`, toggleVisible: !!toggle, toggleOverlapsMessage: overlap, railHeader: header });
        fs.writeFileSync(path.join(shots, `monitor-${state}-${tag}-${theme}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      }
    }
    if (!base) {
      await run('integration.setOpen(true)'); await sleep(200);
      await run("document.querySelector('[data-plan-minimize]').click()"); await sleep(200);
      report.checks.push({ name: 'minimize closes the rail and restores the toggle', passed: await run("!document.querySelector('aside')&&!!document.querySelector('[data-plan-toggle]')") });
      await run("document.querySelector('[data-plan-toggle]').click()"); await sleep(200);
      report.checks.push({ name: 'toggle reopens the rail', passed: await run("!!document.querySelector('aside')&&!document.querySelector('[data-plan-toggle]')") });
    }
    report.background = { focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e)); }
  finally {
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy(); app.exit(report.errors.length || report.checks.some((c) => c.passed === false) ? 1 : 0);
  }
});
