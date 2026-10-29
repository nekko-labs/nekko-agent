// Per-window composers evidence (#1317): three agents tiled on the wall, one
// working through a looped plan with sub-agents and a Linear task, captured
// hidden and off-screen on a throwaway profile. With NEKKO_TEST_SOURCE pointing
// at main it captures the shared wall composer instead, without asserting.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], captures: [], errors: [] };
// Verify failed once and sent the work back to Build: Build is on its second pass.
const SEED = `(() => {
  const f = layoutFixture, t = Date.now() - 600000, [a, b, c] = f.records;
  const plan = (id, steps) => ({ id, name: 'update_plan', input: { steps } });
  const steps = [['Find every inline session check', 'explore'], ['Move session checks into one middleware', 'build'], ['Auth tests and e2e login pass', 'verify'], ['Open the PR', 'ship']];
  const call1 = plan('p1', steps.map(([title, kind], i) => ({ title, kind, status: i ? 'pending' : 'active' })));
  const call2 = plan('p2', [{ id: 'step_1', status: 'done', note: '14 routes, all under server/routes' }, { id: 'step_2', status: 'active' }]);
  const call3 = plan('p3', [{ id: 'step_2', status: 'active', note: 'Pass 1 dropped the old sid cookie; adding the fallback' }]);
  a.title = 'Refactor auth middleware';
  a.messages = [
    { id: 'm1', role: 'user', content: 'Work on this Linear task: Move session checks into one middleware\\nLink: https://linear.app/nekko/issue/NEK-412/move-session-checks', createdAt: t },
    { id: 'm2', role: 'assistant', content: 'Starting with where the checks live.', toolCalls: [call1], createdAt: t + 1000 },
    { id: 'm3', role: 'assistant', content: 'Found all 14. Building the middleware now.', toolCalls: [call2], createdAt: t + 3000 },
    { id: 'm4', role: 'assistant', content: 'The e2e login test failed on the first pass: the old sid cookie is no longer read. Back in Build to add the fallback, then I will verify again.', toolCalls: [call3], createdAt: t + 8000 },
  ];
  a.agentPlan = steps.map(([title, kind], i) => ({ id: 'step_' + (i + 1), title, kind, status: i === 0 ? 'done' : i === 1 ? 'active' : 'pending', createdAt: t, updatedAt: t + 8000 }));
  a.agentPlan[0].note = '14 routes, all under server/routes';
  a.agentPlan[1].note = 'Pass 1 dropped the old sid cookie; adding the fallback';
  a.agentPlan[1].pass = 2;
  a.agentPlan[2].verification = { status: 'failed', device: 'macOS', detail: 'e2e / auth failed on pass 1' };
  const child = (id, title, at) => ({ ...c, id, title, parentSessionId: 'a', createdAt: at, updatedAt: at, messages: [] });
  f.records.push(child('k1', 'Map session checks', t + 2000), child('k2', 'Update 14 route files', t + 4000), child('k3', 'Cookie fallback tests', t + 9000));
  b.title = 'Fix flaky e2e on checkout';
  b.messages = [{ id: 'b1', role: 'user', content: 'The checkout spec fails about one run in eight. Find out why.', createdAt: t }, { id: 'b2', role: 'assistant', content: 'The cart badge updates after the route change, so the click lands on a stale button. I added a wait on the settled count.', createdAt: t + 2000 }];
  c.title = 'Draft 0.42 release notes';
  c.messages = [{ id: 'c1', role: 'user', content: 'Draft the release notes for 0.42.', createdAt: t }, { id: 'c2', role: 'assistant', content: '0.42: dictation everywhere. Desktop and iPhone now listen all the time and act on Nekko commands.', createdAt: t + 2000 }];
  for (const s of f.records) f.putCachedSession(s);
})()`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, expression) => { const value = await run(expression); report.checks.push({ name, value }); if (!process.env.NEKKO_TEST_SOURCE && !value) throw Error(name); };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({root:{id:'s1',dir:'row',children:[{id:'a-pane',kind:'chat',refId:'a'},{id:'s2',dir:'col',children:[{id:'b-pane',kind:'chat',refId:'b'},{id:'c-pane',kind:'chat',refId:'c'}],sizes:[0.5,0.5]}],sizes:[0.55,0.45]},hero:'a',watermark:1,autoAdd:false,layout:{mode:'grid'},dock:{show:false},agentPanel:{show:false},zones:true,zonesIntro:true,activeZone:'a-pane'}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-chat-surface]")'); i++) await sleep(100);
    await run(`(() => { const h = document.documentElement; const off = () => h.removeAttribute('data-app-inactive'); off(); new MutationObserver(off).observe(h, { attributes: true, attributeFilter: ['data-app-inactive'] }); })()`);
    await run(SEED);
    await run(`layoutFixture.store.getState().refreshSessions()`);
    // a and its route-file sub-agent are mid-turn: a streamed reply makes each a live run.
    await sleep(600);
    await run(`for (const id of ['a', 'k2']) layoutFixture.emitAgent({ type: 'text', sessionId: id, delta: 'Working on it.' })`);
    await sleep(1500);
    await shot('wall-grid');
    await check('no shared wall composer', `!document.querySelector('[data-wall-composer].wall-composer, .wall-composer-row')`);
    await check('every agent window has its own composer', `['a','b','c'].every(id => !!document.querySelector('[data-grid-cell="chat:' + id + '"] .composer'))`);
    await check('only the selected window composer is open', `!document.querySelector('[data-grid-cell="chat:a"] [data-resting]') && !!document.querySelector('[data-grid-cell="chat:b"] [data-resting]') && !!document.querySelector('[data-grid-cell="chat:c"] [data-resting]')`);
    await check('resting composer is one row', `(() => { const r = document.querySelector('[data-grid-cell="chat:b"] .composer')?.getBoundingClientRect(); return !!r && r.height < 64; })()`);
    await check('header: numbered agent, then Nekko with its badge', `(() => { const icon = document.querySelector('[data-grid-cell="chat:a"] [data-pane-title-strip]'); const n = icon?.querySelector('.numbered-agent-icon'), m = icon?.querySelector('[data-wall-mascot="working"] .wall-mascot-badge'); return !!n && !!m && !!(n.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING); })()`);
    await check('plan folds to the working step with its kind and pass', `(() => { const s = document.querySelector('[data-grid-cell="chat:a"] [data-plan-sheet][data-folded]'); return !!s && s.textContent.includes('Build') && s.textContent.includes('Pass 2') && s.textContent.includes('2 of 4'); })()`);
    await check('folded sub-agents read 1 running, 2 done', `document.querySelector('[data-grid-cell="chat:a"] [data-plan-chip="subagents"]')?.getAttribute('title') === 'Sub-agents: 1 running, 2 done'`);
    await check('the Linear task rides the folded sheet', `[...document.querySelectorAll('[data-grid-cell="chat:a"] [data-plan-chip="project"]')].some(e => e.textContent.includes('NEK-412'))`);
    await check('sheet is tucked behind the composer', `(() => { const w = document.querySelector('[data-grid-cell="chat:a"]'); const p = w?.querySelector('.plan-sheet-dock'), c = w?.querySelector('.composer'); if (!p || !c) return false; const a = p.getBoundingClientRect(), b = c.getBoundingClientRect(); return a.bottom > b.top && a.bottom <= b.top + 12 && a.width < b.width; })()`);
    await run(`document.querySelector('[data-grid-cell="chat:a"] .plan-sheet-fold, [data-grid-cell="chat:a"] .plan-sheet-toggle')?.click()`);
    await sleep(400);
    await shot('wall-plan-open');
    await check('open plan puts each sub-agent under its step', `document.querySelectorAll('[data-plan-step-id="step_1"] [data-plan-chip="subagent"]').length === 1 && document.querySelectorAll('[data-plan-step-id="step_2"] [data-plan-chip="subagent"]').length === 2`);
    await check('open plan puts the task on the first step', `!!document.querySelector('[data-plan-step-id="step_1"] [data-plan-chip="project"]')`);
    await run(`document.querySelector('[data-grid-cell="chat:a"] .plan-sheet-toggle')?.click()`);
    const at = await run(`(() => { const r = document.querySelector('[data-grid-cell="chat:b"] .composer')?.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...at, button: 'left', clickCount: 1 });
    await sleep(400);
    await shot('wall-select-b');
    await check('picking another window opens its composer and rests the first', `!document.querySelector('[data-grid-cell="chat:b"] [data-resting]') && !!document.querySelector('[data-grid-cell="chat:a"] [data-resting]')`);
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    app.quit();
  }
});
