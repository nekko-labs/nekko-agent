// Full App new-chat evidence. Run through layout-evidence-integration.cjs.
// NEKKO_TEST_SOURCE can point at an unchanged base tree for matching captures.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'New chat gradient, isolated evidence', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({ root: { id: 'gradient-pane', kind: 'chat', refId: 'd' }, hero: 'd', watermark: 1, autoAdd: false, layout: { mode: 'focus' }, dock: { show: false }, agentPanel: { show: false } }));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!document.querySelector("[data-clean-start] .clean-start")'); i++) await sleep(100);
    if (!await run('!!document.querySelector("[data-clean-start] .clean-start")')) throw Error('New chat did not mount');
    for (const width of [1440, 900, 460]) {
      win.setContentSize(width, 900); await sleep(700);
      const file = path.join(out, `new-chat-${width}.png`);
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      report.captures.push(file);
      report.checks.push(await run(`(() => {
        const e = document.querySelector('[data-clean-start] .clean-start');
        const c = document.querySelector('[data-clean-start] .composer');
        const before = getComputedStyle(e, '::before'), after = getComputedStyle(e, '::after');
        const r = c.getBoundingClientRect();
        return { width: innerWidth, theme: document.documentElement.dataset.theme, gradient: before.backgroundImage, grain: after.backgroundImage, grainAnimation: after.animationName, grainPointerEvents: after.pointerEvents, composerVisible: r.width > 200 && r.left >= 0 && r.right <= innerWidth };
      })()`));
    }
    // Renderer input only. The overlay must not consume composer input.
    await run(`(() => { const e = document.querySelector('[data-clean-start] [contenteditable]'); if (!e) throw Error('Missing editor'); e.focus(); document.execCommand('insertText', false, 'Plan a desktop task'); })()`);
    if (!await run("document.querySelector('[data-clean-start] [contenteditable]').textContent.includes('Plan a desktop task')")) throw Error('Composer interaction failed');
    report.bounds = win.getBounds(); report.hidden = !win.isVisible(); report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    if (!process.env.NEKKO_TEST_SOURCE && report.checks.some(c => !c.gradient.startsWith('linear-gradient') || !c.grain.includes('data:image/svg+xml') || c.grainAnimation !== 'none' || c.grainPointerEvents !== 'none' || !c.composerVisible)) throw Error('Gradient/grain acceptance check failed');
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'gradient-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
