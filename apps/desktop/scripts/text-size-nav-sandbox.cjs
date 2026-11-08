// Synthetic Settings section nav check at each text size: clicking a section
// must land on it, whatever root zoom the text size has applied.
// Launch: NEKKO_LAYOUT_SANDBOX=text-size-nav-sandbox.cjs node layout-evidence-integration.cjs
// Stub bridge only. Hidden, non-focusable window; clicks are DOM events, no OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const report = { checks: [], errors: [], measures: {} };
  const win = new BrowserWindow({
    width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 3000, y: -2000,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, ...(process.env.NEKKO_PAGE_ZOOM ? { preload: path.join(__dirname, 'text-size-preload.cjs') } : {}) },
  });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  const run = (source) => win.webContents.executeJavaScript(source, true);
  // Where a click on one section landed: the group at the top, and how far its top is from the scroller's.
  const landing = (id) => run(`(() => { try {
    const target = document.getElementById('settings-' + ${js(id)});
    let scroller = target.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    const top = scroller.getBoundingClientRect().top;
    const groups = [...scroller.querySelectorAll('[data-settings-group]')];
    const shown = groups.filter((g) => g.getBoundingClientRect().top <= top + 24).at(-1)?.dataset.settingsGroup;
    return { offset: Math.round(target.getBoundingClientRect().top - top), shown, atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 };
  } catch (e) { return { failure: String(e) }; } })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1500);
    await run(`layoutFixture.store.getState().setView('settings')`);
    await sleep(1500);
    const ids = await run(`[...document.querySelectorAll('[data-settings-group]')].map((g) => g.dataset.settingsGroup)`);
    for (const scale of [80, 100, 125, 150]) {
      await run(`window.nekko.updateSettings({ textScale: ${scale} }).then((s) => { layoutFixture.store.setState({ settings: { ...s } }); layoutFixture.store.getState().applyTheme(); })`);
      await sleep(500);
      report.measures[scale] = {};
      for (const id of ids) {
        const title = await run(`document.getElementById('settings-${id}-title')?.textContent ?? ''`);
        const clicked = await run(`(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find((n) => n.textContent.trim() === ${js(title)}); if (b) b.click(); return !!b; })()`);
        await sleep(450);
        const land = await landing(id);
        report.measures[scale][id] = land;
        report.checks.push({ name: `${scale}% ${id}`, passed: clicked && (land.shown === id || land.atBottom) });
      }
    }
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.passed).map((c) => c.name);
  console.log(JSON.stringify({ total: report.checks.length, failed, errors: report.errors, at150: report.measures[150] }, null, 1));
  app.exit(0);
});
