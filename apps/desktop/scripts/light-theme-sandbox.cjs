// Real shared renderer, synthetic records, isolated profile and no network or host.
// Run via NEKKO_CONTROLS_SANDBOX=light-theme-sandbox.cjs agent-window-controls-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use agent-window-controls-integration.cjs');
const dir = path.join(out, 'light-themes');
fs.mkdirSync(dir, { recursive: true });
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: [], captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1400, height: 900, useContentSize: true, frame: false, x: -5000, y: -5000, show: false, focusable: false, skipTaskbar: true, title: 'Light theme evidence sandbox', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = script => win.webContents.executeJavaScript(script, true);
  const check = (name, ok, facts) => { report.checks.push({ name, ok, facts }); if (!ok) throw Error(name + ': ' + JSON.stringify(facts)); };
  const shot = async name => {
    const file = path.join(dir, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
    if (process.env.NEKKO_LIGHT_THEME_INSPECT === '1' && report.captures.length === 1) {
      console.log('Inspection hold: hidden Light theme evidence sandbox, ' + file);
      await sleep(60000);
    }
  };
  const settle = async () => {
    await sleep(500);
    await run("document.getAnimations().forEach(a => { if (a.effect?.getTiming().iterations === Infinity) { a.pause(); a.currentTime = 12000; } else { try { a.finish(); } catch {} } })");
    await win.capturePage(undefined, { stayHidden: true });
    await sleep(150);
  };
  // JSON values embedded into renderer code must not become script markup.
  const js = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const theme = async preset => {
    await run(`integration.theme({ theme: ${js(preset.endsWith('dark') ? 'dark' : 'light')}, themePreset: ${js(preset)}, defaultProviderId: 'fixture', defaultModelId: 'fixture-model' }); integration.records().forEach(s => integration.state().setPlanRail(s.id, false));`);
    await settle();
    check('theme applied: ' + preset, await run(`document.documentElement.dataset.preset === ${js(preset)}`));
  };
  const focused = async () => {
    await run(`[...document.querySelectorAll('.wall-layout-segments button')].find(b => b.textContent.trim() === 'Focused')?.click(); document.querySelector('[aria-label="Show the agent panel"]')?.click();`);
    await settle();
    await run("[...document.querySelectorAll('[data-agent-panel] .agent-chip')].find(c => c.title === 'Existing conversation').click()");
    await settle();
  };
  const load = async () => {
    await win.loadFile(path.join(out, 'index.html'), { query: { multi: '1' } });
    for (let i = 0; i < 100 && !await run('!!window.integration && !!document.querySelector(".command-wall-window")'); i++) await sleep(100);
  };
  const resize = async width => {
    win.setContentSize(width, 900);
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await settle();
  };
  try {
    await load();
    win.webContents.debugger.attach('1.3');
    for (const preset of ['x-plum-white', 'x-indigo-white', 'x-plum-dark', 'x-indigo-dark']) {
      await theme(preset); await focused();
      for (const width of [1400, 460]) {
        await resize(width); await shot(`${preset}-existing-${width}`);
        await run("document.querySelector('.command-wall-window[data-wall-selected] .composer [contenteditable], .command-wall-window[data-wall-selected] .composer textarea').scrollIntoView({ block: 'nearest' })");
        await settle();
        const hit = await run(`(() => { const ed=document.querySelector('.command-wall-window[data-wall-selected] .composer [contenteditable], .command-wall-window[data-wall-selected] .composer textarea'); const r=ed.getBoundingClientRect(); const target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return ed===target || ed.contains(target); })()`);
        check(`composer hit testing: ${preset} ${width}`, hit);
      }
      await resize(1400);
    }
    await theme('x-plum-white');
    // Real-time capture of the existing cycle; no accelerated playback or new timing.
    const frames = [];
    await run("document.getAnimations().filter(a => a.animationName === 'agent-window-colour').forEach(a => { a.currentTime = 10000; a.play(); })");
    for (let i = 0; i < 20; i++) {
      frames.push((await win.capturePage(undefined, { stayHidden: true })).resize({ width: 840 }).toPNG());
      await sleep(200);
    }
    const movie = path.join(dir, 'x-plum-white-cycle.gif');
    require('./evidence-gif.cjs')(movie, frames, 20);
    report.captures.push(movie);
    await settle();
    await run(`(() => { const ed=document.querySelector('.command-wall-window[data-wall-selected] .composer [contenteditable], .command-wall-window[data-wall-selected] .composer textarea'); ed.focus(); document.execCommand('insertText', false, 'Light theme typing check'); })()`);
    check('typing passes through gradient', await run("document.querySelector('.command-wall-window[data-wall-selected] .composer').textContent.includes('Light theme typing check')"));
    await run("[...document.querySelectorAll('.wall-layout-segments button')].find(b => b.textContent.trim() === 'Dynamic')?.click()");
    await settle();
    const inactive = await run("[...document.querySelectorAll('.command-wall-window:not([data-wall-selected]) > .panel')].map(s => ({ glow: getComputedStyle(s).getPropertyValue('--nekko-glow').trim(), animation: getComputedStyle(s, '::before').animationName, opacity: getComputedStyle(s, '::before').opacity }))");
    check('inactive panes have no gradient cycle', inactive.length > 0 && inactive.every(p => p.glow === '0' && p.animation === 'none' && p.opacity === '0'), inactive);
    await shot('x-plum-white-dynamic-1400');
    await focused();
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await settle();
    check('reduced motion keeps static field', await run("(() => { const p=document.querySelector('.command-wall-window[data-wall-selected] > .panel'); return getComputedStyle(p, '::before').animationName === 'none' && getComputedStyle(p).transitionDuration === '0s' && getComputedStyle(p).backgroundImage.includes('radial-gradient'); })()"));
    await shot('x-plum-white-reduced-motion-1400');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    await run("(() => { const record = JSON.parse(JSON.stringify(integration.records()[0])); record.messages = []; sessionStorage.setItem('fixture-record', JSON.stringify(record)); })()");
    await load();
    for (const preset of ['x-plum-white', 'x-indigo-white']) {
      await theme(preset); await focused();
      check('new chat greeting: ' + preset, await run("!!document.querySelector('.command-wall-window[data-wall-selected] [data-clean-start]')"));
      for (const width of [1400, 460]) { await resize(width); await shot(`${preset}-new-${width}`); }
      await resize(1400);
    }
    check('never shown or focused', !win.isVisible() && !win.isFocused());
  } catch (error) { report.errors.push(String(error.stack || error)); }
  finally {
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy();
    await session.defaultSession.closeAllConnections();
    app.exit(report.errors.length ? 1 : 0);
  }
});
