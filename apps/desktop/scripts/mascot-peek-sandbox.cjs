// Per-chat Nekko evidence: the cat peeking over the composer's left end beside
// the plan sheet, and his pupils following the caret as text is typed.
// Captured hidden and off-screen on a throwaway profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], captures: [], gaze: [], errors: [] };
const SEED = `(() => {
  const f = layoutFixture, t = Date.now() - 600000, s = f.records[0];
  s.messages = [
    { id: "m1", role: "user", content: "Tidy the settings page and open a PR.", createdAt: t },
    { id: "m2", role: "assistant", content: "Working through it now.", createdAt: t + 2000 },
  ];
  s.agentPlan = [
    { id: "p1", title: "Read the settings layout", status: "completed", createdAt: t, updatedAt: t + 2000 },
    { id: "p2", title: "Group the toggles by section", status: "in_progress", createdAt: t, updatedAt: t + 2000 },
    { id: "p3", title: "Open the PR", status: "pending", createdAt: t, updatedAt: t + 2000 },
  ];
  f.putCachedSession(s);
})()`;
// A hidden window paints (and runs animation frames) only when captured, so
// force a frame before reading the gaze the frame callback sets.
const GAZE = `(() => { const g = document.querySelector('.chat-mascot [data-nekko-look]'); return g && g.getAttribute('transform'); })()`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const shot = async (name, rect) => { const file = path.join(out, name + '.png'); await win.capturePage(undefined, { stayHidden: true }); await sleep(400); fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, expression) => { const value = await run(expression); report.checks.push({ name, value }); if (!process.env.NEKKO_TEST_SOURCE && !value) throw Error(name); };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({root:{id:'a-pane',kind:'chat',refId:'a'},hero:'a',watermark:1,zonesIntro:true,autoAdd:false,layout:{mode:'focus'},dock:{show:false},agentPanel:{show:false}}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-chat-surface]")'); i++) await sleep(100);
    // A hidden window counts as an inactive app, which pauses every animation
    // (html[data-app-inactive]) and leaves the window mid-entrance; keep it active.
    await run(`(() => { const h = document.documentElement; const off = () => h.removeAttribute('data-app-inactive'); off(); new MutationObserver(off).observe(h, { attributes: true, attributeFilter: ['data-app-inactive'] }); })()`);
    await run(SEED);
    await run(`layoutFixture.store.getState().refreshSessions()`);
    await run(`layoutFixture.store.setState({ focusRequest: { sessionId: 'a' } })`);
    await sleep(2500);
    for (let i = 0; i < 30 && !await run(`!!document.querySelector('[data-plan-sheet]')`); i++) await sleep(100);
    await sleep(800);
    const rect = await run(`(() => { const c = document.querySelector('.composer-column'); if (!c) return null; const b = c.getBoundingClientRect(); return { x: Math.max(0, Math.round(b.left) - 40), y: Math.max(0, Math.round(b.top) - 120), width: Math.round(b.width) + 80, height: Math.round(b.height) + 140 }; })()`);
    report.rect = rect;
    await shot('window');
    if (rect) await shot('composer', rect);
    await check('the plan sheet shows', `!!document.querySelector('[data-plan-sheet]')`);
    await check('Nekko sits in the composer', `!!document.querySelector('.composer > .chat-mascot')`);
    await check('Nekko is left of the plan sheet', `(() => { const m = document.querySelector('.chat-mascot svg').getBoundingClientRect(), p = document.querySelector('.plan-sheet-dock').getBoundingClientRect(); return m.left + 70 * m.width / 80 <= p.left - 12; })()`);
    await check('the composer edge meets his chin', `(() => { const m = document.querySelector('.chat-mascot svg').getBoundingClientRect(), c = document.querySelector('.composer').getBoundingClientRect(); return Math.abs(m.top + 62.5 - c.top) < 1.5; })()`);
    report.gaze.push(['rest', (await win.capturePage(undefined, { stayHidden: true }), await sleep(150), await run(GAZE))]);
    // Type a long line: the caret walks right across the composer.
    await run(`document.querySelector('.composer [contenteditable]').focus()`);
    const typed = 'Also make the toggles line up with their labels on narrow windows, and check the dark theme';
    for (let i = 0; i < typed.length; i++) {
      await win.webContents.sendInputEvent({ type: 'char', keyCode: typed[i] });
      if (i === 2 || i === typed.length - 1) { await sleep(250); report.gaze.push([i === 2 ? 'caret-left' : 'caret-right', (await win.capturePage(undefined, { stayHidden: true }), await sleep(150), await run(GAZE))]); }
    }
    if (rect) await shot('composer-typing', rect);
    // Home: the caret jumps back to the start of the line.
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Home' }); await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Home' });
    await sleep(250); report.gaze.push(['caret-home', (await win.capturePage(undefined, { stayHidden: true }), await sleep(150), await run(GAZE))]);
    const x = (k) => Number(/translate\(([-\d.]+)/.exec(report.gaze.find(g => g[0] === k)?.[1] ?? '')?.[1]);
    report.checks.push({ name: 'eyes move right as the caret does', value: x('caret-right') > x('caret-left') });
    report.checks.push({ name: 'eyes return left on Home', value: x('caret-home') < x('caret-right') });
    report.hidden = !win.isVisible(); report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    report.success = report.checks.every(c => c.value || process.env.NEKKO_TEST_SOURCE);
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks, gaze: report.gaze, errors: report.errors.slice(0, 5), success: report.success })); win.destroy(); app.exit(report.success ? 0 : 1); }
});
