// Isolated, hidden real-renderer evidence for the Agents panel's window-type
// switcher (#2787). Run through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_FIXTURE=wall-polish-fixture.tsx NEKKO_LAYOUT_SANDBOX=agent-panel-shows-sandbox.cjs.
// NEKKO_BASELINE=1 captures the base revision (no switcher) without its checks.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const base = process.env.NEKKO_BASELINE === '1';
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { checks: [], captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const check = (name, ok, facts) => { report.checks.push({ name, ok, facts }); if (!ok) throw Error('Check failed: ' + name + ' ' + JSON.stringify(facts)); };
  const shot = async (name) => { await sleep(500); const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  // Frames of the thumb sliding, for a recording; a capture takes longer than a frame, so this samples.
  const frames = async (name, click) => {
    const dir = path.join(out, name); fs.mkdirSync(dir, { recursive: true });
    await run(click);
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, String(i).padStart(3, '0') + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(dir);
  };
  const pick = (label) => `document.querySelector('[data-agent-panel-shows] [role="radio"][aria-label="${label}"]').click()`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run("!!document.querySelector('[data-agent-panel]')")); i++) await sleep(200);
    await sleep(600);
    await shot('panel-agents');
    if (base) {
      report.success = true;
      return;
    }
    const facts = await run(`(() => {
      const panel = document.querySelector('[data-agent-panel]');
      const head = panel.querySelector('[data-agent-panel-header]').getBoundingClientRect();
      const shows = panel.querySelector('[data-agent-panel-shows] [role="radiogroup"]').getBoundingClientRect();
      const segs = [...panel.querySelectorAll('[data-agent-panel-shows] [role="radio"]')].map((b) => ({ label: b.getAttribute('aria-label'), on: b.getAttribute('aria-checked') === 'true', w: Math.round(b.getBoundingClientRect().width) }));
      return { segs, belowHeader: shows.top >= head.bottom - 1, panelWidth: Math.round(panel.getBoundingClientRect().width), switcherWidth: Math.round(shows.width), rowButton: !!document.querySelector('[aria-label="Show agents in a row"], [aria-label="Show agents in a column"]') };
    })()`);
    check('four segments, Agents picked', JSON.stringify(facts.segs.map((s) => [s.label, s.on])) === JSON.stringify([['Agents', true], ['Terminals', false], ['Photos and videos', false], ['Files', false]]), facts);
    check('switcher sits under the header and spans the panel', facts.belowHeader && facts.switcherWidth >= facts.panelWidth - 40, facts);
    check('segments share the width evenly', Math.max(...facts.segs.map((s) => s.w)) - Math.min(...facts.segs.map((s) => s.w)) <= 1, facts);
    check('no column/row button', !facts.rowButton, facts);

    await frames('slide-to-files', pick('Files'));
    await sleep(400);
    check('Files lists no agents', await run(`!document.querySelector('[data-companion-row]')`), {});
    await run(pick('Files')); await sleep(500);
    await shot('panel-files');
    await run(pick('Terminals')); await sleep(500);
    check('Terminals view says when none are open', await run(`document.querySelector('[data-agent-panel-empty]')?.textContent === 'No terminals open'`), {});
    await shot('panel-terminals');
    check('the view button shows only for Agents', !(await run(`!!document.querySelector('[data-agent-view-button]')`)), {});
    await run(pick('Agents')); await sleep(500);
    check('back on Agents the view button returns', await run(`!!document.querySelector('[data-agent-view-button]')`), {});
    report.success = true;
  } catch (error) {
    report.success = false;
    report.errors.push(String(error && error.stack || error));
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, success: report.success, checks: report.checks.map((c) => `${c.ok ? 'ok ' : 'NO '} ${c.name}`), errors: report.errors.slice(0, 5) }, null, 2));
    win.destroy();
    app.quit();
  }
});
