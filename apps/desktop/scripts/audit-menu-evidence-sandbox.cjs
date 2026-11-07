// The chat's context menu with "Audit trail", and the trail it opens, over the
// full app (wall-controls-fixture.tsx). Hidden window, no network or real data.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const label = process.env.NEKKO_TEST_LABEL || 'head';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [], checks: {} };
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await sleep(300); const f = path.join(out, `${name}-${label}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run("!!document.querySelector('.command-wall-window [data-chat-surface]')")); i++) await sleep(100);
    // Let the wall finish mounting its composer before the right-click.
    for (let i = 0; i < 100 && !(await run("!!document.querySelector('[data-wall-composer] [data-chat-mode-button]')")); i++) await sleep(100);
    await sleep(800);
    report.checks.surfaces = await run("[...document.querySelectorAll('[data-chat-surface]')].map(e => e.dataset.chatSurface)");
    // The transcript's surface, never the shared composer's (which opens no chat menu).
    await run("[...document.querySelectorAll('.command-wall-window [data-chat-surface]')].find(e => e.dataset.chatSurface !== 'composer').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:240,clientY:260}))");
    await sleep(300);
    report.checks.menu = await run("document.querySelector('[role=menu]')?.innerText");
    await shot('audit-menu');
    if (await run("[...document.querySelectorAll('[role=menu] *')].some(e => e.textContent === 'Audit trail')")) {
      await run(`window.nekko.readAudit = async () => [
        { at: Date.UTC(2026,10,7,0,41,0), turnId: 't1', type: 'turn', mode: 'guardrails', model: 'fixture-model' },
        { at: Date.UTC(2026,10,7,0,41,2), turnId: 't1', type: 'tool', tool: 'read_file', ms: 3, outputChars: 120, detail: { path: 'src/app.ts' } },
        { at: Date.UTC(2026,10,7,0,41,4), turnId: 't1', type: 'approval', tool: 'bash', severity: 'medium', answer: 'approved', by: { via: 'this computer' } },
        { at: Date.UTC(2026,10,7,0,41,6), turnId: 't1', type: 'tool', tool: 'bash', ms: 840, outputChars: 300, detail: { program: 'npm' } },
      ]; true`);
      await run("[...document.querySelectorAll('[role=menu] button, [role=menu] [role=menuitem]')].find(b => b.textContent.includes('Audit trail')).click()");
      await sleep(500);
      report.checks.opened = await run("!!document.querySelector('[data-audit-trail]')");
      await shot('audit-open');
    }
    if (win.isVisible() || win.isFocused()) report.errors.push('visible or focused');
    report.success = report.errors.length === 0 && !!report.checks.menu;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
