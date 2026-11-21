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
  const run = s => win.webContents.executeJavaScript(s, true);
  const scrollTo = sel => run(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'end'}); 0`);
  const click = sel => run(`document.querySelector(${JSON.stringify(sel)}).click()`);
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
    for (let i = 0; i < 70 && !(await run('!!window.layoutFixture')); i++) await wait(100);
    for (const width of [1250, 360]) for (const theme of ['dark', 'light']) {
      const name = `${width}-${theme}`;
      win.setContentSize(width, 850);
      await run(`layoutFixture.composerSeed = (r) => { delete layoutFixture.settings.themePreset; layoutFixture.settings.theme = '${theme}'; r.toolApproach = 'code'; r.orchestrate = undefined; }; layoutFixture.showFolderComposer(false, true, '${width === 1250 ? 'window' : 'full'}', '')`);
      await wait(500);
      await run(`(()=>{document.documentElement.dataset.theme='${theme}'; window.optionWrites = []; window.writeOptions = layoutFixture.bridge.setSessionOptions; layoutFixture.bridge.setSessionOptions = async (id, patch) => { window.optionWrites.push(patch); return window.writeOptions(id, patch); }; })(); 0`);
      await click('[data-chat-mode-button]'); await wait(400);
      const section = 'section[aria-label="Approach"]';
      const sel = `${section} button[role=switch][aria-label=Orchestrate]`;
      const checked = () => run(`document.querySelector(${JSON.stringify(sel)})?.getAttribute('aria-checked') ?? null`);
      check(`${name}: Approach visible`, await run(`document.querySelector('${section}')?.checkVisibility()`));
      check(`${name}: existing Tool style remains Code mode`, await run(`document.querySelector('[data-mode-fly=tools]').innerText.includes('code mode')`));
      check(`${name}: ${before ? 'no existing control' : 'defaults off'}`, (await checked()) === (before ? null : 'false'));
      await scrollTo(section);
      if (!before) {
        check(`${name}: switch is within the viewport`, await run(`(() => {const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight})()`));
      }
      await shot(`mode-approach-${name}`);
      if (!before) {
        await click(sel); await wait(340);
        check(`${name}: turns on with a one-field patch`, (await checked()) === 'true' && await run(`optionWrites.length===1 && JSON.stringify(optionWrites[0])==='{"orchestrate":true}' && layoutFixture.records[0].toolApproach==='code'`));
        if (theme === 'dark') await shot(`orchestrate-on-${width}`);
        await click(sel); await wait(200);
        check(`${name}: turns off with a one-field patch`, (await checked()) === 'false' && await run(`optionWrites.length===2 && JSON.stringify(optionWrites[1])==='{"orchestrate":false}' && layoutFixture.records[0].toolApproach==='code'`));
      }
      await run('layoutFixture.bridge.setSessionOptions = window.writeOptions; 0');
      await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 0`); await wait(170);
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
