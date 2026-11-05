// Monitors in Simple and Detailed: the checked monitors in Configure are the
// ones the panel shows, and the mode only opens or closes the panel. Run
// through layout-evidence-integration.cjs (NEKKO_LAYOUT_SANDBOX=monitors-mode-sandbox.cjs);
// NEKKO_TEST_SOURCE can point at an unchanged base tree for the "before" captures.
// Hidden, off-screen, non-focusable window, isolated profile, network blocked.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const js = value => JSON.stringify(value).replace(/</g, '\\u003c');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { scenes: {}, checks: [], errors: [] };
app.disableHardwareAcceleration();
// Five of six checked, Insights unchecked: the panel should show exactly those five.
const monitors = { hardware: true, localModels: true, utilization: true, budget: true, automations: true, insights: false };
const wall = (dock) => ({ root: { id: 'mode-pane', kind: 'chat', refId: 'd' }, hero: 'd', watermark: 1, autoAdd: false, layout: { mode: 'focus' }, dock: { side: 'right', monitors, ...dock }, agentPanel: { show: true }, zonesIntro: true });
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'Monitors mode, isolated evidence', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  let seeded = null;
  // Seed before any renderer code runs, so the App's own save on unload cannot overwrite it.
  const scene = async (name, mode, dock) => {
    await win.loadURL('about:blank');
    if (seeded) await win.webContents.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: seeded });
    ({ identifier: seeded } = await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.protocol === 'file:') { localStorage.clear(); localStorage.setItem('nekko.chatMode', ${js(mode)}); localStorage.setItem('nekko.commandWall', ${js(JSON.stringify(wall(dock)))}); }` }));
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!document.querySelector(".monitors-dock, .monitors-dock-collapsed")').catch(() => false); i++) await sleep(100);
    // Let the panel finish opening; a hidden window repaints only when asked.
    // First-run intros cover the board in this fixture: close them.
    const capture = async (file) => {
      await sleep(1500);
      await run(`document.querySelectorAll('[role="dialog"] button[aria-label^="Close" i], [role="dialog"] button[aria-label^="Skip" i]').forEach(b => b.click())`);
      for (let i = 0; i < 2; i++) { win.webContents.invalidate(); await sleep(600); await win.capturePage(undefined, { stayHidden: true }); }
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      return file;
    };
    const file = await capture(path.join(out, `${name}.png`));
    const open = await run('!!document.querySelector(".monitors-dock[data-panel-open=true]")');
    const shown = await run(`[...document.querySelectorAll('[data-monitor]')].map(s => s.getAttribute('aria-label').replace(/ monitor$/, ''))`);
    let checked = null, configure = null;
    if (open) {
      await run(`document.querySelector('[aria-label="Configure monitors"]').click()`); await sleep(300);
      checked = await run(`[...document.querySelectorAll('.monitors-dock__popover label')].filter(l => l.querySelector('input').checked).map(l => l.querySelector('strong').textContent)`);
      configure = await capture(path.join(out, `${name}-configure.png`));
    }
    report.scenes[name] = { mode, open, checked, shown, file, configure };
    return report.scenes[name];
  };
  try {
    const simple = await scene('simple-panel-open', 'simple', { show: true, simpleShow: true });
    const detailed = await scene('detailed-panel-open', 'expert', { show: true, simpleShow: true });
    const simpleDefault = await scene('simple-default', 'simple', { show: true });
    const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
    report.checks.push({ name: 'Simple: shown monitors match the checked ones', pass: simple.open && same(simple.checked, simple.shown) });
    report.checks.push({ name: 'Detailed: shown monitors match the checked ones', pass: detailed.open && same(detailed.checked, detailed.shown) });
    report.checks.push({ name: 'Switching mode keeps the same monitors', pass: same(simple.shown, detailed.shown) });
    report.checks.push({ name: 'Simple starts with the panel closed', pass: !simpleDefault.open });
  } catch (e) { report.errors.push(String(e && e.stack || e)); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(process.exitCode || 0);
});
