// The phone-style model chip (effort gauge + name, one menu with an Effort section) and the folder on the
// bottom row. Expert mode, one wall window on a model that advertises effort, captured hidden and off-screen.
//   NEKKO_LAYOUT_SANDBOX=model-effort-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const report = { checks: {}, captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const rect = sel => run(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
  const shot = async (name, r) => {
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(r || undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 200)); });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.chatMode', 'expert'); localStorage.setItem('nekko.commandWall', JSON.stringify({root:{id:'a-pane',kind:'chat',refId:'a'},hero:'a',watermark:1,autoAdd:false,layout:{mode:'grid'},dock:{show:false},agentPanel:{show:false},zones:true,zonesIntro:true,activeZone:'a-pane'}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-chat-surface]")'); i++) await sleep(100);
    await run(`(() => {
      const f = layoutFixture, st = f.store, a = f.records[0];
      const effort = { levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => ({ effort: e })), default: 'medium' };
      st.setState({ models: st.getState().models.map((m) => ({ ...m, name: 'Claude Opus 5.5', effort })) });
      f.bridge.listModels = async () => st.getState().models;
      Object.assign(a, { effort: 'high', executionMode: 'worktree', gitIsolation: true });
      f.putCachedSession(a);
    })()`);
    await run(`layoutFixture.store.getState().refreshSessions()`);
    await sleep(1500);
    await shot('composer', await rect('.composer'));
    report.checks.gaugeInChip = await run(`!!document.querySelector('button[aria-haspopup="listbox"] [data-effort-gauge]')`);
    report.checks.standaloneEffort = await run(`document.querySelectorAll('.effort-trigger').length`);
    report.checks.folderOnBottomRow = await run(`!!document.querySelector('[data-composer-mode-row] > .composer-folders') && !document.querySelector('.composer-bar .composer-folders')`);
    await run(`document.querySelector('button[aria-haspopup="listbox"]').click()`);
    await sleep(700);
    report.checks.effortSectionInMenu = await run(`!!document.querySelector('[data-effort-section] input[type="range"]')`);
    await shot('model-menu-open');
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ checks: report.checks, errors: report.errors.slice(0, 5), captures: report.captures.length }));
    app.exit(process.exitCode || 0);
  }
});
