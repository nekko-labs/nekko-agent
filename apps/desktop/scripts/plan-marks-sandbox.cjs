// Plan bullets that carry their check, sub-agent rows tied to their parent card
// by a tree line, and the banner across a sub-agent's chat. Hidden, off-screen,
// non-focusable, throwaway profile. Launch: NEKKO_LAYOUT_SANDBOX=plan-marks-sandbox.cjs
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
  const step = (id, title, kind, status, verification) => ({ id, title, kind, status, createdAt: t, updatedAt: Date.now(), ...(verification ? { verification } : {}) });
  s.agentPlan = [
    step('step_1', 'Android attention badges', 'build', 'done', { status: 'passed', device: 'Android' }),
    step('step_2', 'iOS turn completion details', 'build', 'done', { status: 'active', device: 'iOS' }),
    step('step_3', 'Relay attention badge delivery', 'build', 'done', { status: 'pending', device: 'iOS / Android / relay' }),
    step('step_4', 'Finish relay badge tests', 'build', 'active', { status: 'pending', device: 'iOS / Android' }),
    step('step_5', 'Badge counts survive a restart', 'build', 'done', { status: 'failed', device: 'iOS', detail: 'Count reset to 0 after relaunch.' }),
    step('step_6', 'Open the PR', 'ship', 'pending'),
  ];
  const kid = (id, title, reply) => ({ ...s, id, title, parentSessionId: 'a', agentPlan: undefined, createdAt: t + 2000, messages: [
    { id: id + 'u', role: 'user', content: title, createdAt: t + 2000 },
    ...(reply ? [{ id: id + 'a', role: 'assistant', content: reply, createdAt: t + 3000 }] : []),
  ] });
  f.records.push(kid('k1', 'Android attention badges', 'Badges render on the launcher icon.'), kid('k2', 'iOS turn completion details', 'Details show on the lock screen.'), kid('k3', 'Relay attention badge delivery', 'The relay forwards badge counts.'), kid('k4', 'Finish relay badge tests'));
  f.records.forEach(f.putCachedSession);
})()`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  // Web Animations (the zone-move crossfade) ignore the CSS override: finish the finite ones.
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
    // Hidden Chromium can leave CSS motion at time zero; stills want the settled frame (SVG SMIL is untouched).
    await run(`(() => { const style = document.createElement('style'); style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'; document.head.append(style); })()`);
    await run(SEED);
    await run(`layoutFixture.store.getState().refreshSessions()`);
    await sleep(700);
    await run(`layoutFixture.store.setState({ focusRequest: { sessionId: 'a' } })`);
    // k4 and the parent are mid-run, so k4's row wears the rocket.
    await run(`['k4', 'a'].forEach((sessionId) => layoutFixture.emitAgent({ type: 'text', sessionId, delta: '' }))`);
    await run(`(() => { const style = document.createElement('style'); style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'; document.head.append(style); })()`);
    await sleep(1500);
    // The sub-agent rows arrive with the session list refresh; wait for all four.
    for (let i = 0; i < 50 && await run(`document.querySelectorAll('[data-agent-panel] [data-subagent-row]').length`) < 4; i++) await sleep(200);
    await sleep(500);
    report.panelWidth = await run(`document.querySelector('[data-agent-panel]')?.getBoundingClientRect().width`);
    report.rows = await run(`[...document.querySelectorAll('[data-agent-panel] button')].map(b => b.textContent.trim().slice(0, 40)).slice(0, 30)`);
    report.tree = await run(`[...document.querySelectorAll('[data-subagent-row]')].map(b => b.dataset.subagentRow + ':' + b.querySelector('[data-subagent-tree]')?.dataset.subagentTree)`);
    await shot('wall');
    await shot('agent-panel', { x: 60, y: 365, width: 260, height: 200 });
    const sheet = await run(`(() => { const r = document.querySelector('[data-plan-sheet]')?.getBoundingClientRect(); return r ? { x: Math.max(0, Math.floor(r.x) - 8), y: Math.max(0, Math.floor(r.y) - 8), width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 } : null; })()`);
    if (sheet) await shot('plan-sheet', sheet);
    await check('no verification chips beside the steps', `!document.querySelector('[data-plan-chip="verify"]')`);
    await check('the running check shows the working ripple on its bullet', `!!document.querySelector('[data-plan-substep="step_2:check"] [data-plan-check="active"] .plan-working')`);
    await check('a pending check on a done step is a plain bullet', `!document.querySelector('[data-plan-substep="step_3:check"] .plan-working')`);
    await check('the failed check shows on its bullet', `document.querySelector('[data-plan-substep="step_5:check"] [data-plan-check="failed"]')?.getAttribute('aria-label') === 'Check failed on iOS'`);
    await check('each sub-agent row has a tree line, the last an elbow', `(() => { const t = [...document.querySelectorAll('[data-agent-panel] [data-subagent-row] [data-subagent-tree]')].map(e => e.dataset.subagentTree); return t.length === 4 && t.slice(0, 3).every(x => x === 'tee') && t[3] === 'last'; })()`);
    await check('the status icon leads each sub-agent row', `[...document.querySelectorAll('[data-agent-panel] [data-subagent-row]')].every(b => b.children[1]?.getAttribute('role') === 'img')`);
    await check('the running sub-agent wears the rocket in front', `!!document.querySelector('[data-agent-panel] [data-subagent-row="k4"] > .status-rocket')`);
    await run(`document.querySelector('[data-subagent-row="k2"]').click()`);
    await sleep(2500);
    report.banner = await run(`[...document.querySelectorAll('[data-subagent-banner]')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), e.textContent]; })`);
    await shot('subagent-chat');
    await shot('subagent-chat-top', { x: 0, y: 0, width: 1440, height: 260 });
    await check('a sub-agent chat says so and names its parent', `!!document.querySelector('[data-subagent-banner][aria-label="Sub-agent of Mobile Agent Attention Notifications"]')`);
    report.hidden = !win.isVisible(); report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks, errors: report.errors, success: report.success })); win.destroy(); app.exit(report.success ? 0 : 1); }
});
