// Compact subagent tree, model identity, saved expansion preference and navigation.
// Hidden, off-screen, non-focusable, throwaway profile.
// Launch: NEKKO_LAYOUT_SANDBOX=compact-subagents-sandbox.cjs
// node apps/desktop/scripts/layout-evidence-integration.cjs (NEKKO_TEST_SOURCE=<main checkout> for "before").
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const before = !!process.env.NEKKO_TEST_SOURCE;
const report = { checks: [], captures: [], errors: [] };
const SEED = `(() => {
  const f = layoutFixture, t = Date.now() - 600000, s = f.records[0];
  s.title = 'Mobile Agent Attention Notifications';
  s.messages = [
    { id: 'm1', role: 'user', content: 'Ship attention badges on iOS, Android and the relay.', createdAt: t },
    { id: 'm2', role: 'assistant', content: 'Four sub-agents are on it; I am checking each surface.', turnStats: { stop: 'complete' }, createdAt: t + 1000 },
  ];
  const kid = (id, title, reply) => ({ ...s, id, title, parentSessionId: 'a', agentPlan: undefined, createdAt: t + 2000, messages: [
    { id: id + 'u', role: 'user', content: title, createdAt: t + 2000 },
    ...(reply ? [{ id: id + 'a', role: 'assistant', content: reply, createdAt: t + 3000 }] : []),
  ] });
  f.records.push(kid('k1', 'Android attention badges', 'Badges render on the launcher icon.'), kid('k2', 'iOS turn completion details', 'Details show on the lock screen.'), kid('k3', 'Relay attention badge delivery', 'The relay forwards badge counts.'), kid('k4', 'Finish relay badge tests'));
  f.records.forEach((r) => { if (r.parentSessionId) r.modelId = 'gpt-5.4-mini'; f.putCachedSession(r); });
})()`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  // Finish finite entrance animations before stills, not during motion capture.
  const settle = () => run(`document.getAnimations().forEach(a => { try { a.finish(); } catch {} })`);
  const shot = async (name, rect) => { await settle(); await sleep(100); const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, expression) => { const value = await run(expression); report.checks.push({ name, value }); if (!before && !value) throw Error(name); };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 200)); });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({root:{id:'a-pane',kind:'chat',refId:'a'},hero:'a',watermark:1,zonesIntro:true,autoAdd:false,layout:{mode:'focus'},dock:{show:false},agentPanel:{show:true}}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-agent-panel]")'); i++) await sleep(100);
    await sleep(700);
    await run(`(() => { const h = document.documentElement; const off = () => h.removeAttribute('data-app-inactive'); off(); new MutationObserver(off).observe(h, { attributes: true, attributeFilter: ['data-app-inactive'] }); })()`);
    await run(SEED);
    await run(`layoutFixture.store.getState().refreshSessions()`);
    await sleep(700);
    await run(`layoutFixture.store.setState({ focusRequest: { sessionId: 'a' } })`);
    await sleep(1000);
    const panelRect = () => run(`(() => { const r = document.querySelector('[data-agent-panel]').getBoundingClientRect(); return {x:Math.floor(r.x), y:Math.floor(r.y), width:Math.ceil(r.width), height:Math.ceil(r.height)}; })()`);
    const visibleRows = `[...document.querySelectorAll('[data-agent-panel] [data-subagent-row]')].filter(e => !e.closest('[inert]'))`;
    await shot('desktop-panel', await panelRect());
    await check('default two visible subagents', `${visibleRows}.length === 2`);
    await check('persisted model visible', `document.querySelector('[data-subagent-row] [data-subagent-route]')?.textContent.includes('gpt-5.4-mini')`);
    await check('child titles semibold', `getComputedStyle(document.querySelector('[data-subagent-row] [data-subagent-title]') || document.body).fontWeight === '600'`);
    await check('parent titles semibold', `getComputedStyle(document.querySelector('.agent-chip-heading > .truncate') || document.body).fontWeight === '600'`);
    if (!before) {
      await check('remaining count on disclosure', `document.querySelector('[data-subagent-toggle]')?.textContent.includes('Show more (2)')`);
      const frames = [];
      const rect = await panelRect();
      frames.push((await win.capturePage(rect, {stayHidden:true})).toPNG());
      await run(`document.querySelector('[data-subagent-toggle]').click()`);
      for (let i = 0; i < 8; i++) { await sleep(40); frames.push((await win.capturePage(rect, {stayHidden:true})).toPNG()); }
      await sleep(300);
      await check('all four expanded', `${visibleRows}.length === 4`);
      await shot('desktop-expanded', await panelRect());
      await run(`document.querySelector('[data-subagent-toggle]').click()`);
      for (let i = 0; i < 8; i++) { await sleep(40); frames.push((await win.capturePage(rect, {stayHidden:true})).toPNG()); }
      await sleep(300);
      const {PNG} = require('pngjs'), {GifWriter} = require('omggif');
      const decoded = frames.map(f => PNG.sync.read(f));
      const counts = new Map();
      for (const f of decoded) for (let i = 0; i < f.data.length; i += 4) { const c = (f.data[i] << 16) | (f.data[i+1] << 8) | f.data[i+2]; counts.set(c, (counts.get(c) || 0) + 1); }
      const palette = [...counts].sort((a,b) => b[1]-a[1]).slice(0,256).map(([c])=>c);
      while (palette.length < 256) palette.push(0);
      const cache = new Map();
      const nearest = c => { if (cache.has(c)) return cache.get(c); let pick=0, best=Infinity; for(let i=0;i<256;i++){ const p=palette[i], d=((c>>16)-(p>>16))**2+(((c>>8)&255)-((p>>8)&255))**2+((c&255)-(p&255))**2; if(d<best){best=d;pick=i;} } cache.set(c,pick); return pick; };
      const bytes = Buffer.alloc(decoded[0].width * decoded[0].height * decoded.length * 2);
      const gif = new GifWriter(bytes, decoded[0].width, decoded[0].height, {palette, loop:0});
      decoded.forEach((f,index) => { const pixels = new Uint8Array(f.width*f.height); for(let i=0;i<pixels.length;i++) pixels[i]=nearest((f.data[i*4]<<16)|(f.data[i*4+1]<<8)|f.data[i*4+2]); gif.addFrame(0,0,f.width,f.height,pixels,{delay:index===0 || index===8 ? 80:8}); });
      fs.writeFileSync(path.join(out,'accordion.gif'),bytes.subarray(0,gif.end()));
      report.motionFrames = decoded.length;
      await check('collapse back to two', `${visibleRows}.length === 2`);
      await run(`window.nekko.updateSettings({expandSubagents:true}).then(settings => layoutFixture.store.setState({settings}))`);
      await sleep(300);
      await check('saved preference expands mounted lists', `${visibleRows}.length === 4 && layoutFixture.settings.expandSubagents === true`);
      await run(`window.nekko.updateSettings({expandSubagents:false}).then(settings => layoutFixture.store.setState({settings}))`);
      await sleep(300);
      await check('saved closed preference restores two', `${visibleRows}.length === 2`);
    }
    if (!before) {
      await run(`document.querySelector('[data-subagent-row="k2"]').click()`);
      await sleep(1500);
      await check('child opens its own chat', `!!document.querySelector('[data-subagent-banner]')`);
    }
    win.setContentSize(390, 844);
    await run(`layoutFixture.showSubagentPanel()`);
    await sleep(500);
    // Phone-width web uses its navigation drawer, not the native phone UI.
    await run(`document.querySelector('[aria-label="Open agent list"]')?.click()`);
    await sleep(500);
    await shot('narrow-panel');
    await check('narrow panel actually visible', `document.querySelector('[data-agent-panel]').getBoundingClientRect().width > 0`);
    win.setContentSize(1000, 900);
    await run(`layoutFixture.showSubagentSettings()`);
    await sleep(500);
    await shot('settings');
    if (!before) {
      await run(`document.querySelector('#expand-subagents').click()`);
      await sleep(100);
      await check('settings switch persists expanded default', `layoutFixture.settings.expandSubagents === true`);
    }
    report.hidden = !win.isVisible(); report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    if (report.errors.length) throw Error('Renderer or isolation errors recorded');
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
