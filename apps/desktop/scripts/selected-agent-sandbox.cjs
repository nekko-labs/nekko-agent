// Real App, synthetic bridge, hidden isolated profile. Run with layout-evidence-integration.cjs.
// The 480px hit test currently exposes baseline issue #1909 on both main and head;
// keep the assertion until that drawer-stacking bug is fixed.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => {
    assert.equal(await run("!!document.querySelector('[role=dialog]')"), false, 'No tutorial may obscure the sidebar');
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
    const hit = await run("(() => { const e = document.querySelector('.agent-chip-chat[data-agent-active]'); const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { visible: e.contains(hit), rect: r.toJSON(), hit: hit?.outerHTML.slice(0, 500) }; })()");
    report[name] = hit;
    assert.ok(hit.visible, 'Selected row is visible and hit-testable: ' + JSON.stringify(hit));
  };
  // A hidden window may defer a transition's first frame until capture. Sample
  // after settled paints so style assertions do not read its start value.
  const rows = async () => {
    for (let i = 0; i < 8; i++) {
      await win.capturePage(undefined, { stayHidden: true });
      await sleep(200);
    }
    return run(`Array.from(document.querySelectorAll('.agent-chip-chat')).map(e => ({ title: e.title, active: e.hasAttribute('data-agent-active'), background: getComputedStyle(e).backgroundColor, border: getComputedStyle(e).borderWidth, shadow: getComputedStyle(e).boxShadow }))`);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run("document.querySelectorAll('.agent-chip-chat').length >= 4")); i++) await sleep(200);
    assert.equal(await run("document.querySelectorAll('.agent-chip-chat').length"), 4);
    // Close the real first-visit tutorial before testing the sidebar underneath.
    for (let i = 0; i < 30 && !(await run("!!document.querySelector('.zones-intro')")); i++) await sleep(100);
    await run("document.querySelector('.zones-intro [aria-label=\"Close\"]')?.click()");
    await sleep(300);
    assert.equal(await run("!!document.querySelector('.zones-intro')"), false);
    // Keep the same data and default Nekko dark theme for base and changed code.
    await run("(async () => { const settings = await window.nekko.updateSettings({ theme: 'dark', themePreset: 'x-plum-dark', showTips: false, firstPromptIntroSeen: true }); layoutFixture.store.setState({ settings }); document.documentElement.dataset.theme = 'dark'; document.documentElement.dataset.preset = 'x-plum-dark'; })()");
    await run("document.querySelector('.agent-chip-chat[title=\"Persist quota history\"]').click()");
    await sleep(1000);
    report.initial = await rows();
    assert.equal(report.initial.filter(r => r.active).length, 1);
    await shot('selected-agent-desktop');
    const target = await run(`(() => { const b = document.querySelector('.agent-chip-chat[data-agent-active]').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...target });
    await sleep(250);
    assert.deepEqual(await rows(), report.initial);
    report.checks.push('Hover preserves selection background');
    await run("document.querySelector('.agent-chip-chat[title=\"Diagnose failed build\"]').click()");
    await sleep(500);
    report.switched = await rows();
    assert.equal(report.switched.filter(r => r.active).length, 1);
    assert.equal(report.switched.find(r => r.active).title, 'Diagnose failed build');
    report.checks.push('Click moves selection to exactly one row');
    // Keyboard opening uses the same selection path.
    await run("document.querySelector('.agent-chip-chat[title=\"Persist quota history\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    await sleep(500);
    assert.deepEqual(await rows(), report.initial);
    report.checks.push('Enter restores selection');
    await run("document.querySelector('[aria-label=\"Show agents in a row\"]').click()");
    assert.deepEqual(await rows(), report.initial);
    await shot('selected-agent-horizontal');
    await run("document.querySelector('[aria-label=\"Show agents in a column\"]').click()");
    await rows();
    report.checks.push('Horizontal panel keeps the same selected-row treatment');
    if (process.env.NEKKO_EXPECT_SELECTION === '1') {
      for (const row of report.initial) {
        assert.equal(row.background === 'rgba(0, 0, 0, 0)', !row.active);
        assert.equal(row.border, '0px');
        assert.equal(row.shadow, 'none');
      }
      assert.notEqual(report.switched.find(r => r.active).background, 'rgba(0, 0, 0, 0)');
      assert.equal(report.switched.find(r => r.title === 'Persist quota history').background, 'rgba(0, 0, 0, 0)');
      report.checks.push('Only the selected row is tinted, without border or shadow');
    }
    report.hidden = !win.isVisible();
    assert.ok(report.hidden);
    win.setContentSize(480, 900);
    await sleep(400);
    await run("document.querySelector('[aria-label=\"Open agent list\"]').click()");
    await sleep(500);
    report.narrow = await rows();
    assert.deepEqual(report.narrow, report.initial);
    await shot('selected-agent-narrow');
  } catch (error) { report.errors.push(String(error.stack || error)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
