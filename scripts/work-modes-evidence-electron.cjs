const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
const report = { kind, checks: [], errors: [], captures: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, d) => d(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({ width: 1100, height: 560, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 5000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true } });
  win.on('focus', () => report.errors.push('OS focus taken'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const settle = async () => { await run('document.fonts.ready'); await sleep(300); };
  const capture = async (name) => { await settle(); const img = await win.capturePage(undefined, { stayHidden: true }); const file = path.join(dir, name + '.png'); fs.writeFileSync(file, img.toPNG()); report.captures.push(file); };
  const check = async (name, s) => { try { report.checks.push({ name, passed: !!(await run(s)) }); } catch (e) { report.checks.push({ name, passed: false, error: String(e) }); } };
  try {
    await win.loadFile(path.join(dir, 'index.html')); win.showInactive(); await settle();
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      await run(`document.querySelector('.ctl-menu').click()`); await settle();
      await check(theme + ' menu open', `!!document.querySelector('[role=menu]')`);
      await capture(`${kind}-menu-${theme}`);
      if (kind === 'after') {
        await check(theme + ' menu inside viewport', `(()=>{const r=document.querySelector('[role=menu]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0})()`);
        await run(`document.querySelector('[data-work-mode="better-review"]').click()`); await settle();
        await check(theme + ' sets only workMode', `JSON.stringify(evidence.calls.at(-1).patch)==='{"workMode":"better-review"}'`);
        await check(theme + ' button shows the mode', `document.querySelector('.ctl-menu').innerText.includes('Better review')`);
        await check(theme + ' permission unchanged', `evidence.record().mode==='yolo'`);
        await capture(`${kind}-button-${theme}`);
        await run(`document.querySelector('.ctl-menu').click()`); await settle();
        await capture(`${kind}-menu-selected-${theme}`);
        await run(`document.querySelector('[data-work-mode="default"]').click()`); await settle();
      } else { await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await settle(); }
      await capture(`${kind}-button-default-${theme}`);
    }
    report.background = { focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e)); }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(kind, JSON.stringify({ failed: report.checks.filter((c) => !c.passed), passed: report.checks.filter((c) => c.passed).length, errors: report.errors })); win.destroy(); app.exit(report.errors.length ? 1 : 0); }
});
