// Hidden, non-focusable native Electron windows. Separate profile, no external
// network, no credentials, and a synthetic bridge. Captures real components.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const baseline = process.env.NEKKO_FUSION_BASELINE === '1';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nekko-fusion-evidence-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {}); // Keep the harness alive between disposable windows.
const results = [], windows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(win, expression) {
  for (let n = 0; n < 80; n++) { if (await win.webContents.executeJavaScript(`!!(${expression})`)) return; await sleep(50); }
  throw Error(`Timeout: ${expression}`);
}
async function check(win, label, expression) {
  const passed = await win.webContents.executeJavaScript(`!!(${expression})`);
  results.push({ label, passed }); if (!passed) {
    results.push({ diagnostic: await win.webContents.executeJavaScript('({state: window.integration.state(), text: document.body.innerText})') });
    throw Error(label);
  }
}
async function capture(win, name) {
  await sleep(180);
  const png = await win.capturePage(undefined, { stayHidden: true, stayAwake: false }); fs.writeFileSync(path.join(out, name + '.png'), png.toPNG());
}
async function open(surface, theme, width) {
  const win = new BrowserWindow({ title: `Nekko Fusion · ${baseline ? 'baseline' : 'changed'} · isolated`, width, height: surface === 'settings' ? 1000 : 900,
    show: false, focusable: false, paintWhenInitiallyHidden: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  windows.push(win);
  win.webContents.on('console-message', (_e, _l, message) => { if (message.includes('Error')) results.push({ console: message }); });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadFile(path.join(out, 'index.html'), { query: { surface } });
  await wait(win, 'window.integration');
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await sleep(180); return win;
}
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
  for (const theme of ['light', 'dark']) for (const width of [1200, 390]) {
    const win = await open('picker', theme, width);
    const run = (s) => win.webContents.executeJavaScript(s);
    await run(`document.querySelector('[data-subagent-model-control] button').click()`);
    await wait(win, "document.querySelector('[data-subagent-choice=\"auto-local\"]')");
    await capture(win, `picker-${theme}-${width}`);
    if (theme === 'light' && width === 390) {
      const frames = [];
      const scrollSelector = baseline ? '#subagent-model-list [role="listbox"]' : '#subagent-model-list';
      for (let frame = 0; frame < 20; frame++) {
        await run(`(() => { const panel = document.querySelector('${scrollSelector}'); panel.scrollTop = (panel.scrollHeight - panel.clientHeight) * ${frame / 19}; })()`);
        await sleep(75);
        frames.push((await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
      }
      fs.writeFileSync(path.join(out, 'subagent-scroll-390.gif'), require('./fusion-evidence-gif.cjs')(frames));
      await run(`document.querySelector('${scrollSelector}').scrollTop = 0`);
      await sleep(100);
    }
    if (!baseline) {
      await check(win, 'Footer does not overlap routing options', `(() => { const footer = document.querySelector('[data-subagent-model-control]').getBoundingClientRect(); const rows = [...document.querySelectorAll('[aria-label="Model"] > button')]; return rows.every(r => r.getBoundingClientRect().bottom <= footer.top + 1); })()`);
      await check(win, 'Pinned chat explains provider boundary', "document.body.innerText.includes('Provider locked')");
      await check(win, 'All capability targets available', "document.querySelector('[aria-label=\"Subagent capability target\"]').options.length === 5");
      await run(`const select = document.querySelector('[aria-label="Subagent capability target"]'); select.value = 'medium'; select.dispatchEvent(new Event('change', { bubbles: true }));`);
      await wait(win, "window.integration.state().settings.orchestration.subagentTier === 'medium'");
      await run(`document.querySelector('[data-subagent-choice="auto-local"]').click()`);
      await wait(win, "window.integration.state().settings.orchestration.subagentModel === 'auto-local'");
      await check(win, 'Local preference preserves Medium but not Fusion permission', "window.integration.state().settings.orchestration.subagentTier === 'medium' && !window.integration.state().fusion");
      await run(`document.querySelectorAll('button[role="option"]').forEach(b => { if(b.textContent.startsWith('Fusion')) b.click(); })`);
      await wait(win, 'window.integration.state().fusion');
      await check(win, 'Fusion explicitly enabled', "document.body.innerText.includes('Fusion') && window.integration.state().model === '__auto__'");
      await run('window.integration.reopen()');
      await sleep(80);
      await run(`document.querySelectorAll('button[role="option"]').forEach(b => { if(b.textContent.includes('Auto · this provider')) b.click(); })`);
      await wait(win, '!window.integration.state().fusion');
      await check(win, 'Auto removes provider permission', "window.integration.state().model === '__auto__' && document.body.innerText.includes('Auto · this provider')");
    }
    win.destroy();
    const settings = await open('settings', theme, width);
    if (!baseline) {
      await settings.webContents.executeJavaScript(`document.querySelector('[data-fusion-settings] button').click()`);
      await wait(settings, "document.querySelector('[aria-label=\"Capability for LM Studio: Local coding model\"]')");
      await settings.webContents.executeJavaScript(`const strategy = document.querySelector('[aria-label="Fusion strategy"]'); strategy.value = 'local-first'; strategy.dispatchEvent(new Event('change', {bubbles:true}));`);
      await wait(settings, "window.integration.state().settings.fusion.strategy === 'local-first'");
      await settings.webContents.executeJavaScript(`var tier = document.querySelector('[aria-label="Capability for LM Studio: Local coding model"]'); tier.value = 'medium'; tier.dispatchEvent(new Event('change', {bubbles:true}));`);
      await wait(settings, "window.integration.state().settings.fusion.modelTiers['local::custom-coder'] === 'medium'");
      await check(settings, 'Custom tier saved and identified', "document.body.innerText.includes('Your classification')");
      await check(settings, 'Model names retain readable width', `Array.from(document.querySelectorAll('[data-model-tier-editor] label > span')).every(s => s.getBoundingClientRect().width > 70)`);
      await capture(settings, `settings-${theme}-${width}`);
      await settings.webContents.executeJavaScript(`var tier = document.querySelector('[aria-label="Capability for LM Studio: Local coding model"]'); tier.value = 'suggested'; tier.dispatchEvent(new Event('change', {bubbles:true}));`);
      await wait(settings, "!window.integration.state().settings.fusion.modelTiers['local::custom-coder']");
      await check(settings, 'Reset removes override', "document.body.innerText.includes('Unclassified')");
    } else { await capture(settings, `settings-${theme}-${width}`); }
    settings.destroy();
  }
  if (process.env.NEKKO_FUSION_HOLD === '1') {
    await open('settings', 'light', 1200);
    fs.writeFileSync(path.join(out, 'ready-for-native-capture'), 'ready');
    await new Promise((r) => setTimeout(r, 110000));
  }
}).catch((e) => { results.push({ error: String(e), stack: e.stack }); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(results, null, 2));
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  fs.rmSync(profile, { recursive: true, force: true }); app.exit(results.some((r) => r.error || r.passed === false) ? 1 : 0);
});
