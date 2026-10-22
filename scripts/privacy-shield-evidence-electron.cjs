// Hidden, off-screen, non-focusable capture of the Privacy Shield fixture. DOM clicks only.
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
  const win = new BrowserWindow({ width: 760, height: 820, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 5000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true } });
  win.on('focus', () => report.errors.push('OS focus taken'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const settle = async () => { await run('document.fonts.ready'); await sleep(400); };
  const capture = async (name, sel) => {
    await settle();
    let rect;
    if (sel) { const r = await run(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:Math.floor(r.left)-12,y:Math.floor(r.top)-12,width:Math.ceil(r.width)+24,height:Math.ceil(r.height)+24}})()`); rect = r; }
    const img = await win.capturePage(rect, { stayHidden: true }); const file = path.join(dir, name + '.png'); fs.writeFileSync(file, img.toPNG()); report.captures.push(file);
  };
  const check = async (name, s) => { try { report.checks.push({ name, passed: !!(await run(s)) }); } catch (e) { report.checks.push({ name, passed: false, error: String(e) }); } };
  const click = (sel) => run(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const inView = (sel) => `(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`;
  const load = async (query) => { await win.loadFile(path.join(dir, 'index.html'), { query }); await settle(); };
  try {
    win.showInactive();
    for (const theme of ['dark', 'light']) {
      await load({ theme });
      await capture(`${kind}-${theme}-row-crop`, 'main .card');
      if (kind === 'before') { await check(theme + ' no shield control on base', `!document.querySelector('[data-privacy-shield-button]')`); continue; }
      await check(theme + ' shield control between Offline and Incognito', `(()=>{const t=document.querySelector('main .card').innerText;return t.indexOf('Offline')<t.indexOf('Shield')&&t.indexOf('Shield')<t.indexOf('Incognito')})()`);
      await check(theme + ' shield pressed when on', `document.querySelector('[data-privacy-shield-button]').getAttribute('aria-pressed')==='true'`);
      await click('[data-privacy-shield-button]'); await settle();
      await check(theme + ' panel open', `!!document.querySelector('[data-privacy-shield-panel]')`);
      await check(theme + ' panel inside viewport', inView('[data-privacy-shield-panel]'));
      await check(theme + ' panel lists four findings', `document.querySelectorAll('[data-privacy-shield-panel] [data-privacy-finding]').length===4`);
      await capture(`${kind}-${theme}-panel`);
    }
    if (kind === 'after') {
      await load({ theme: 'dark', shield: 'off' });
      await check('shield not pressed when off', `document.querySelector('[data-privacy-shield-button]').getAttribute('aria-pressed')==='false'`);
      await click('[data-privacy-shield-button]'); await settle();
      await check('off panel open', `!!document.querySelector('[data-privacy-shield-panel]')`);
      await capture(`${kind}-dark-shield-off-panel`);
    }
    report.background = { focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e)); }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(kind, JSON.stringify({ failed: report.checks.filter((c) => !c.passed), passed: report.checks.filter((c) => c.passed).length, errors: report.errors })); win.destroy(); app.exit(report.errors.length || report.checks.some((c) => !c.passed) ? 1 : 0); }
});
