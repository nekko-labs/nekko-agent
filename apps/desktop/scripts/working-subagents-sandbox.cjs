// A wall window with a working sub-agent: its indicator sits on the window's
// composer bar beside the microphone, not over the window's corner. Captured
// hidden and off-screen on a throwaway profile. With NEKKO_TEST_SOURCE pointing
// at main it captures the old corner indicator instead, without asserting.
// Launch: NEKKO_LAYOUT_SANDBOX=working-subagents-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], captures: [], errors: [] };
const SEED = `(() => {
  const f = layoutFixture, t = Date.now() - 600000, [a, b] = f.records;
  a.title = 'Refactor auth middleware';
  a.messages = [
    { id: 'm1', role: 'user', content: 'Move the session checks into one middleware.', createdAt: t },
    { id: 'm2', role: 'assistant', content: 'Handing the route files to a sub-agent while I write the middleware.', createdAt: t + 1000 },
  ];
  delete a.agentPlan;
  f.records.push({ ...b, id: 'k1', title: 'Update 14 route files', parentSessionId: 'a', createdAt: t + 2000, updatedAt: t + 2000, messages: [] });
  b.title = 'Fix flaky e2e on checkout';
  b.messages = [{ id: 'b1', role: 'user', content: 'The checkout spec fails about one run in eight. Find out why.', createdAt: t }];
  for (const s of f.records) f.putCachedSession(s);
})()`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const shot = async (name, rect) => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, expression) => { const value = await run(expression); report.checks.push({ name, value }); if (!process.env.NEKKO_TEST_SOURCE && !value) throw Error(name); };
  // The bottom of window a: its composer and the corner the indicator used to cover.
  const corner = () => run(`(() => { const w = document.querySelector('[data-grid-cell="chat:a"]').getBoundingClientRect(), c = document.querySelector('[data-grid-cell="chat:a"] .composer').getBoundingClientRect(); const x = Math.round(w.right - 420), y = Math.round(c.top - 180); return { x, y, width: Math.round(w.right) - x, height: Math.round(w.bottom) - y }; })()`);
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({root:{id:'s1',dir:'row',children:[{id:'a-pane',kind:'chat',refId:'a'},{id:'b-pane',kind:'chat',refId:'b'}],sizes:[0.55,0.45]},hero:'a',watermark:1,autoAdd:false,layout:{mode:'grid'},dock:{show:false},agentPanel:{show:false},zones:true,zonesIntro:true,activeZone:'a-pane'}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-chat-surface]")'); i++) await sleep(100);
    await run(`(() => { const h = document.documentElement; const off = () => h.removeAttribute('data-app-inactive'); off(); new MutationObserver(off).observe(h, { attributes: true, attributeFilter: ['data-app-inactive'] }); })()`);
    await run(SEED);
    await run(`layoutFixture.store.getState().refreshSessions()`);
    await sleep(600);
    // The sub-agent is mid-turn: a streamed reply makes it a live run.
    await run(`layoutFixture.emitAgent({ type: 'text', sessionId: 'k1', delta: 'Working on it.' })`);
    await sleep(1500);
    await shot('wall');
    const rect = await corner();
    await shot('corner', rect);
    await check('the indicator shows for the working sub-agent', `!!document.querySelector('[data-grid-cell="chat:a"] [data-working-subagents]')`);
    await check('it sits on the composer bar, right before the microphone', `(() => { const s = document.querySelector('[data-grid-cell="chat:a"] [data-working-subagents]'); const mic = s?.nextElementSibling; return !!s?.closest('.composer') && !!mic?.matches('[data-voice-island]'); })()`);
    await check('it is as tall as the microphone button', `(() => { const w = document.querySelector('[data-grid-cell="chat:a"]'); const pill = w.querySelector('[data-working-subagents] > button').getBoundingClientRect(), mic = w.querySelector('[aria-label="Start listening"]').getBoundingClientRect(); return Math.round(pill.height) === Math.round(mic.height) && Math.abs((pill.top + pill.height / 2) - (mic.top + mic.height / 2)) < 1; })()`);
    await run(`document.querySelector('[data-grid-cell="chat:a"] [data-working-subagents] > button').click()`);
    await sleep(400);
    await shot('corner-open', rect);
    await check('its list opens above the composer bar', `(() => { const w = document.querySelector('[data-grid-cell="chat:a"]'); const list = w.querySelector('[aria-label="Working subagents"]')?.getBoundingClientRect(), bar = w.querySelector('[data-working-subagents] > button').getBoundingClientRect(); return !!list && list.bottom <= bar.top; })()`);
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    app.exit(process.exitCode || 0);
  }
});
