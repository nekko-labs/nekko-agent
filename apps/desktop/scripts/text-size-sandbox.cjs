// Synthetic Settings > Accessibility evidence: the text size stepper, its live
// preview, and that only Apply changes the app.
// Launch: NEKKO_LAYOUT_SANDBOX=text-size-sandbox.cjs node layout-evidence-integration.cjs
// Stub bridge only. Hidden, non-focusable window; clicks are DOM events, no OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (v) => JSON.stringify(v).replace(/[<>/  ]/g, (c) => '\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const report = { checks: [], errors: [], measures: {} };
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  const win = new BrowserWindow({
    width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 3000, y: -2000,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const capture = async (name) => {
    await run(`document.getElementById('settings-accessibility').scrollIntoView({ block: 'start' })`);
    await sleep(500);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  };
  const click = async (label) => {
    await run(`[...document.querySelectorAll('#accessibility button')].find((b) => (b.getAttribute('aria-label') || b.textContent).startsWith(${js(label)})).click()`);
    await sleep(300);
  };
  const rootZoom = () => run(`document.documentElement.style.zoom`);
  const saved = () => run(`window.nekko.getSettings ? window.nekko.getSettings().then((s) => s.textScale) : null`);
  // The on-screen height of the preview's title, which is what a person reads.
  const titleHeight = () => run(`document.querySelector('[data-text-size-preview] .font-semibold').getBoundingClientRect().height`);
  const sectionText = () => run(`document.getElementById('accessibility').innerText`);
  const disabled = (label) => run(`document.querySelector('#accessibility [aria-label="${label}"]').disabled`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1500);
    await run(`layoutFixture.store.getState().setView('settings')`);
    await sleep(1500);
    await capture('accessibility-100');
    const text = await sectionText();
    check('text size comes before the animation toggle', text.indexOf('Text size') > -1 && text.indexOf('Text size') < text.indexOf('Agent activity animation'));
    check('nothing to apply at rest', !/Apply \d/.test(text));
    const at100 = await titleHeight();

    await click('Increase text size');
    await click('Increase text size');
    const at125 = await titleHeight();
    report.measures.previewTitle = { at100, at125 };
    check('preview grows live', at125 > at100 * 1.2);
    check('the app has not changed yet', (await rootZoom()) === '');
    check('Apply names the size', (await sectionText()).includes('Apply 125%'));
    await capture('accessibility-preview-125');

    await click('Cancel');
    check('Cancel returns the preview', Math.abs((await titleHeight()) - at100) < 0.5);
    check('Cancel leaves the app alone', (await rootZoom()) === '');

    await click('Increase text size');
    await click('Increase text size');
    await click('Apply');
    await sleep(500);
    check('Apply changes the whole app', (await rootZoom()) === '125%');
    check('Apply hides the buttons', !/Apply \d/.test(await sectionText()));
    report.measures.saved = await saved();
    const applied125 = await titleHeight();
    report.measures.previewTitle.applied125 = applied125;
    check('preview does not double up on the applied size', Math.abs(applied125 - at125) < 1);
    await capture('accessibility-applied-125');

    await click('Increase text size');
    check('stops at the upper limit', await disabled('Increase text size'));
    report.measures.previewTitle.preview150 = await titleHeight();
    await capture('accessibility-preview-150');
    await click('Cancel');
    for (let i = 0; i < 4; i += 1) await click('Decrease text size');
    check('stops at the lower limit', await disabled('Decrease text size'));
    check('still not applied', (await rootZoom()) === '125%');
    report.measures.previewTitle.preview80 = await titleHeight();
    await capture('accessibility-preview-80');
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
});
