// Sub-agent fold evidence: a card with sub-agents open, folded away and open again, in the default
// (dark) theme. Synthetic chats only; hidden, off-screen, non-focusable, isolated profile. Launch through
// layout-evidence-integration.cjs with NEKKO_LAYOUT_FIXTURE=subagent-fold-fixture.tsx and
// NEKKO_LAYOUT_SANDBOX=subagent-fold-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Values put into page code: JSON, with the characters that could end a script or a line escaped.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 800, height: 1500, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 2000, y: minY - 1700, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const rectOf = sel => run(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const pad = (r, p = 12) => { const x = Math.max(0, Math.floor(r.x - p)), y = Math.max(0, Math.floor(r.y - p)); return { x, y, width: Math.ceil(r.width + 2 * p), height: Math.ceil(r.height + 2 * p) }; };
  let theme = 'dark';
  const shot = async (name, rect) => {
    await sleep(500);
    win.webContents.invalidate();
    await run('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await sleep(300);
    const f = path.join(out, `${name}-${theme}.png`);
    fs.writeFileSync(f, (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG());
    report.captures.push(f);
  };

  const load = async () => { await win.loadFile(path.join(out, 'index.html')); await sleep(300); for (let i = 0; i < 60 && !(await run("!!document.querySelector('[data-subagent-row]')")); i++) await sleep(200); await sleep(1000); };
  try {
    await load();
    const panel = pad(await rectOf('[data-agent-panel]'), 0);
    const view = { x: 0, y: 0, width: Math.ceil(panel.width + 24), height: 700 };
    await shot('01-sub-agents-shown', view);
    // On a build without the fold (the base), only the first capture is taken.
    if (process.env.NEKKO_BEFORE === '1') { fs.writeFileSync(path.join(out, 'report.json'), js(report, null, 2)); app.quit(); return; }
    const folds = await run("document.querySelectorAll('[data-subagent-fold]').length");
    if (folds !== 2) throw Error('expected 2 fold buttons, got ' + folds);
    // Fold the Done chat's sub-agents (the second button: two rows and Show more), and check the rows are gone and the state is saved.
    await run("document.querySelectorAll('[data-subagent-fold]')[1].click()"); await sleep(500);
    const rows = await run("document.querySelectorAll('[data-subagent-row]').length");
    const saved = await run("localStorage.getItem('nekko.hiddenSubagents')");
    const expanded = await run("document.querySelectorAll('[data-subagent-fold]')[1].getAttribute('aria-expanded')");
    report.checks = { rowsAfterFold: rows, saved, expanded };
    if (expanded !== 'false' || !/p1/.test(saved || '')) throw Error('fold did not register: ' + JSON.stringify(report.checks));
    await shot('02-sub-agents-folded', view);
    // The fold survives a reload.
    await load();
    await shot('03-folded-after-reload', view);
    await run("document.querySelectorAll('[data-subagent-fold]')[1].click()"); await sleep(500);
    await shot('04-sub-agents-shown-again', view);
  } catch (e) { report.errors.push(String(e && e.stack || e)); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), js(report, null, 2));
  console.log(js(report, null, 2));
  app.quit();
});
