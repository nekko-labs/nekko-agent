// Real renderer, synthetic bridge, hidden window and isolated profile. No host calls.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use agent-window-controls-integration.cjs');
const dir = path.join(out, 'dither');
fs.mkdirSync(dir, { recursive: true });
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const baseline = !!process.env.NEKKO_TEST_REVISION;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { baseline, checks: [], captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1400, height: 900, useContentSize: true, frame: false, x: -5000, y: -5000, show: false, focusable: false, skipTaskbar: true, title: 'Chat gradient evidence sandbox', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = script => win.webContents.executeJavaScript(script, true);
  const check = (name, ok, facts) => { report.checks.push({ name, ok, facts }); if (!ok) throw Error(name + ': ' + JSON.stringify(facts)); };
  const shot = async name => {
    const file = path.join(dir, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  const settle = async () => {
    await sleep(600);
    await run("document.getAnimations().forEach(a => { if (a.effect?.getTiming().iterations === Infinity) { a.pause(); a.currentTime = 12000; } else { try { a.finish(); } catch {} } })");
    await win.capturePage(undefined, { stayHidden: true });
    await sleep(200);
  };
  const load = async () => {
    await win.loadFile(path.join(out, 'index.html'), { query: { multi: '1' } });
    for (let i = 0; i < 100 && !await run('!!window.integration && !!document.querySelector(".command-wall-window")'); i++) await sleep(100);
    await run(`integration.theme({ theme: 'dark', themePreset: 'x-plum-dark', defaultProviderId: 'fixture', defaultModelId: 'fixture-model' });
      integration.records().forEach(s => integration.state().setPlanRail(s.id, false));
      [...document.querySelectorAll('.wall-layout-segments button')].find(b => b.textContent.trim() === 'Focused')?.click();
      document.querySelector('[aria-label="Show the agent panel"]')?.click();`);
    await settle();
    await run("[...document.querySelectorAll('[data-agent-panel] .agent-chip')].find(c => c.title === 'Existing conversation').click()");
    await settle();
  };
  const resize = async width => {
    win.setContentSize(width, 900);
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  };
  const grain = () => run(`(() => {
    const section = document.querySelector('.command-wall-window[data-wall-selected] [data-chat-surface] > section');
    const css = getComputedStyle(section, '::after');
    return { content: css.content, image: css.backgroundImage, opacity: css.opacity, pointer: css.pointerEvents, z: css.zIndex, animation: css.animationName, clean: section.classList.contains('clean-start') };
  })()`);
  try {
    await load();
    win.webContents.debugger.attach('1.3');
    await resize(1400);
    await settle();
    const g = await grain();
    check('existing chat scope', !g.clean, g);
    check('existing chat grain only on head', baseline ? g.image === 'none' : g.image.includes('feTurbulence') && g.opacity === '0.055' && g.pointer === 'none' && g.z === '-1' && g.animation === 'none', g);
    for (const width of [1400, 460]) {
      await resize(width); await settle(); await shot('existing-' + width);
      await run("document.querySelector('.command-wall-window[data-wall-selected] .composer [contenteditable], .command-wall-window[data-wall-selected] .composer textarea').scrollIntoView({ block: 'nearest' })");
      await settle();
      const hit = await run(`(() => { const ed=document.querySelector('.command-wall-window[data-wall-selected] .composer [contenteditable], .command-wall-window[data-wall-selected] .composer textarea'); const r=ed.getBoundingClientRect(); const target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return { ok: ed===target || ed.contains(target), rect: r.toJSON(), target: target?.outerHTML.slice(0, 500), viewport: innerWidth }; })()`);
      check('composer hit testing at ' + width, hit.ok, hit);
    }
    await run(`(() => { const ed=document.querySelector('.command-wall-window[data-wall-selected] .composer [contenteditable], .command-wall-window[data-wall-selected] .composer textarea'); ed.focus(); document.execCommand('insertText', false, 'Static grain typing check'); })()`);
    check('typing passes through grain', await run("document.querySelector('.command-wall-window[data-wall-selected] .composer').textContent.includes('Static grain typing check')"));
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    check('grain remains static with reduced motion', (await grain()).animation === 'none');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    await resize(1400);
    await run("[...document.querySelectorAll('.wall-layout-segments button')].find(b => b.textContent.trim() === 'Dynamic')?.click()");
    await settle();
    const inactive = await run("[...document.querySelectorAll('.command-wall-window:not([data-wall-selected]) [data-chat-surface] > section')].map(s => getComputedStyle(s, '::after').backgroundImage)");
    check('inactive chats stay untextured', inactive.length > 0 && inactive.every(image => image === 'none'), inactive);
    await shot('dynamic-1400');
    await run("(() => { const record = JSON.parse(JSON.stringify(integration.records()[0])); record.messages = []; sessionStorage.setItem('fixture-record', JSON.stringify(record)); })()");
    await load();
    const clean = await grain();
    check('new chat retains its original grain', clean.clean && clean.image.includes('feTurbulence') && clean.opacity === '0.055', clean);
    for (const width of [1400, 460]) { await resize(width); await settle(); await shot('new-' + width); }
    check('never shown or focused', !win.isVisible() && !win.isFocused());
  } catch (error) { report.errors.push(String(error.stack || error)); }
  finally {
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
