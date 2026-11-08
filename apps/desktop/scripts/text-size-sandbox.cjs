// Synthetic Settings > Style evidence: the text preview under the code font
// follows the text size at once, with nothing to apply.
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
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
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
    await run(`document.getElementById('style')?.scrollIntoView({ block: 'start' })`);
    await sleep(800);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  };
  const pick = async (size) => {
    await run(`(() => { const s = document.getElementById('style-text-size'); s.value = ${js(String(size))}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(500);
  };
  const rootZoom = () => run(`document.documentElement.style.zoom`);
  // The on-screen height of the preview's title, which is what a person reads.
  const titleHeight = () => run(`document.querySelector('[data-text-size-preview] .font-semibold').getBoundingClientRect().height`);
  const sectionText = () => run(`document.getElementById('style').innerText`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1500);
    await run(`layoutFixture.store.getState().setView('settings')`);
    await sleep(1500);
    // A hidden window runs no animation frames until its first capture, so the nav's scroll starts here.
    await capture('style-100');
    await capture('style-100');
    const text = await sectionText();
    check('preview comes after the code font', text.indexOf('Code font') > -1 && text.indexOf('Code font') < text.indexOf('Preview at 100%'));
    check('nothing to apply', !/Apply \d/.test(text));
    check('Animations has no text size', !(await run(`document.getElementById('animations').innerText`)).includes('Text size'));
    const at100 = await titleHeight();

    await pick(125);
    const at125 = await titleHeight();
    report.measures.previewTitle = { at100, at125 };
    check('picking a size changes the app at once', (await rootZoom()) === '125%');
    check('preview follows the size', at125 > at100 * 1.2 && (await sectionText()).includes('Preview at 125%'));
    await capture('style-preview-125');
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
});
