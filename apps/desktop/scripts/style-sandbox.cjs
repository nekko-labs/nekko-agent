// Synthetic Settings > Style evidence: the bundled website fonts, then a font
// dropped in the fonts folder and a larger text size.
// Launch: NEKKO_LAYOUT_SANDBOX=style-sandbox.cjs node layout-evidence-integration.cjs
// (NEKKO_TEST_SOURCE=<base checkout> for "before"). Stub bridge only.
// Hidden, non-focusable, off-screen window; clicks are DOM events, no OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.on('window-all-closed', () => {});

// A font no machine has installed under this name, so it can only come from the folder.
const custom = fs.readFileSync('/System/Library/Fonts/Supplemental/Chalkduster.ttf').toString('base64');
const fonts = `window.nekko.listFonts = async () => ({ dir: '/Users/you/.nekko-agent/fonts', fonts: [{ family: 'MyHandFont', file: 'MyHandFont.ttf', data: '${custom}' }] }), 0`;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const report = { checks: [], errors: [], measures: {} };
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const capture = async (name) => {
    await sleep(500);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  };
  const win = new BrowserWindow({
    width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 3000, y: -2000,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1500);
    await run(fonts);
    await capture('home');
    report.measures.bodyFont = await run(`getComputedStyle(document.body).fontFamily`);
    report.measures.interLoaded = await run(`document.fonts.check('16px "Inter Tight Variable"')`);
    report.measures.monoLoaded = await run(`document.fonts.check('16px "JetBrains Mono Variable"')`);
    await run(`layoutFixture.store.getState().setView('settings')`);
    await sleep(1500);
    const style = await run(`!!document.getElementById('settings-style')`);
    if (style) {
      await run(`document.getElementById('settings-style').scrollIntoView({ block: 'start' })`);
      await sleep(800);
      await capture('settings-style');
      check('custom font is listed', await run(`[...document.querySelectorAll('#style-font-sans option')].some((o) => o.value === 'MyHandFont')`));
      await run(`window.nekko.updateSettings({ fontSans: 'MyHandFont', textScale: 110 }).then((s) => { layoutFixture.store.setState({ settings: { ...s } }); layoutFixture.store.getState().applyTheme(); })`);
      await sleep(800);
      report.measures.after = await run(`({ ff: getComputedStyle(document.body).fontFamily, ok: document.fonts.check('16px MyHandFont'), faces: [...document.fonts].map((f) => f.family + ':' + f.status).filter((f) => !f.includes('Variable')) })`);
      check('custom font applies to the app', await run(`getComputedStyle(document.body).fontFamily.replaceAll('"', '').startsWith('MyHandFont,') && document.fonts.check('16px MyHandFont')`));
      check('text size applies', await run(`document.documentElement.style.zoom === '110%'`));
      await run(`document.getElementById('settings-style').scrollIntoView({ block: 'start' })`);
      await capture('settings-style-custom');
    } else {
      await capture('settings-top');
    }
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
});
