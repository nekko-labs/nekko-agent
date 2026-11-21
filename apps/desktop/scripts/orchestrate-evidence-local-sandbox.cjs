// Run via layout-evidence-integration.cjs; NEKKO_TEST_SOURCE selects the unchanged baseline.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const before = !!process.env.NEKKO_TEST_SOURCE;
const profile = fs.mkdtempSync(path.join(out, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { before, checks: [], errors: [], captures: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1250, height: 850, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('OS focus taken'));
  win.on('show', () => report.errors.push('OS visibility taken'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const { webContents } = win;
  // Keep renderer scripts fixed: the host selects a literal command, never builds source from values.
  const checked = () => webContents.executeJavaScript(`
    document.querySelector('section[aria-label="Approach"] button[role=switch][aria-label=Orchestrate]')?.getAttribute('aria-checked') ?? null
  `, true);
  const clickOrchestrate = () => webContents.executeJavaScript(`
    document.querySelector('section[aria-label="Approach"] button[role=switch][aria-label=Orchestrate]').click()
  `, true);
  const check = (label, ok) => { report.checks.push({label, ok}); if (!ok) throw Error(label); };
  const shot = async name => {
    await wait(350);
    await win.capturePage(undefined, { stayHidden: true });
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 70 && !(await webContents.executeJavaScript('!!window.layoutFixture', true)); i++) await wait(100);
    await webContents.executeJavaScript(`
      layoutFixture.composerSeed = r => {
        delete layoutFixture.settings.themePreset;
        r.toolApproach = 'code';
        r.orchestrate = undefined;
      };
      0;
    `, true);
    for (const width of [1250, 360]) for (const theme of ['dark', 'light']) {
      const name = `${width}-${theme}`;
      win.setContentSize(width, 850);
      if (theme === 'dark') {
        await webContents.executeJavaScript("layoutFixture.settings.theme = 'dark'", true);
      } else {
        await webContents.executeJavaScript("layoutFixture.settings.theme = 'light'", true);
      }
      if (width === 1250) {
        await webContents.executeJavaScript("layoutFixture.showFolderComposer(false, true, 'window', '')", true);
      } else {
        await webContents.executeJavaScript("layoutFixture.showFolderComposer(false, true, 'full', '')", true);
      }
      await wait(500);
      await webContents.executeJavaScript(`
        document.documentElement.dataset.theme = layoutFixture.settings.theme;
        window.optionWrites = [];
        window.writeOptions = layoutFixture.bridge.setSessionOptions;
        layoutFixture.bridge.setSessionOptions = async (id, patch) => {
          window.optionWrites.push(patch);
          return window.writeOptions(id, patch);
        };
        0;
      `, true);
      await webContents.executeJavaScript("document.querySelector('[data-chat-mode-button]').click()", true); await wait(400);
      check(`${name}: Approach visible`, await webContents.executeJavaScript(`document.querySelector('section[aria-label="Approach"]')?.checkVisibility()`, true));
      check(`${name}: existing Tool style remains Code mode`, await webContents.executeJavaScript("document.querySelector('[data-mode-fly=tools]').innerText.includes('code mode')", true));
      check(`${name}: ${before ? 'no existing control' : 'defaults off'}`, (await checked()) === (before ? null : 'false'));
      await webContents.executeJavaScript(`document.querySelector('section[aria-label="Approach"]').scrollIntoView({block:'end'}); 0`, true);
      if (!before) {
        check(`${name}: switch is within the viewport`, await webContents.executeJavaScript(`(() => {
          const r = document.querySelector('section[aria-label="Approach"] button[role=switch][aria-label=Orchestrate]').getBoundingClientRect();
          return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        })()`, true));
      }
      await shot(`mode-approach-${name}`);
      if (!before) {
        await clickOrchestrate(); await wait(340);
        check(`${name}: turns on with a one-field patch`, (await checked()) === 'true' && await webContents.executeJavaScript(`optionWrites.length===1 && JSON.stringify(optionWrites[0])==='{"orchestrate":true}' && layoutFixture.records[0].toolApproach==='code'`, true));
        if (theme === 'dark') await shot(`orchestrate-on-${width}`);
        await clickOrchestrate(); await wait(200);
        check(`${name}: turns off with a one-field patch`, (await checked()) === 'false' && await webContents.executeJavaScript(`optionWrites.length===2 && JSON.stringify(optionWrites[1])==='{"orchestrate":false}' && layoutFixture.records[0].toolApproach==='code'`, true));
      }
      await webContents.executeJavaScript('layoutFixture.bridge.setSessionOptions = window.writeOptions; 0', true);
      await webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 0`, true); await wait(170);
    }
    check('no renderer errors', !report.errors.length);
    report.background = { visible: win.isVisible(), focused: win.isFocused(), focusable: win.isFocusable(), bounds: win.getBounds() };
    check('window stayed hidden and non-focusable', !report.background.visible && !report.background.focused && !report.background.focusable && report.background.bounds.x < -1000);
  } catch (e) { report.failure = String(e.stack || e); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  win.destroy();
  app.exit(report.failure ? 1 : 0);
});
