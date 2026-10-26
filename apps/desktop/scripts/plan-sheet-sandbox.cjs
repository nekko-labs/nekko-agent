// Plan sheet evidence: a focused chat with a published plan, a PR its agent
// opened and a design link, captured hidden and off-screen on a throwaway profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], captures: [], errors: [] };
// Two plan updates bracket the PR and the design link, so each lands on its own step.
const SEED = `(() => {
  const f = layoutFixture, t = Date.now() - 600000, s = f.records[0];
  const plan = (steps) => ({ id: 'u' + steps.map(x => x.status).join(''), name: 'update_plan', input: { steps } });
  const steps = ['Trace menus, tab selection, and the merged background change', 'Fix neutral menus, active-agent reveal, and new-chat-only gradient', 'Run focused tests and inspect sandbox screenshots and motion', 'Update specs, publish issue and PR with evidence, queue merge'];
  const call1 = plan(steps.map((title, i) => ({ title, status: i ? 'pending' : 'active' })));
  const call2 = plan([{ id: 'step_1', status: 'done', note: 'PR #1123 merged; the separate pixel-wave layer was unchanged.' }, { id: 'step_2', status: 'active' }]);
  const call3 = { id: 'gh', name: 'bash', input: { command: 'gh pr create --fill' } };
  const call4 = plan([{ id: 'step_2', status: 'done', note: 'Implemented focused changes; desktop TypeScript check passes.' }, { id: 'step_3', status: 'active', note: 'Base and head gradient captures taken in isolated hidden Electron windows.' }]);
  s.messages = [
    { id: 'm1', role: 'user', content: 'Fix the menus and the new chat gradient.', createdAt: t },
    { id: 'm2', role: 'assistant', content: 'Starting with the trace.', toolCalls: [call1], createdAt: t + 1000 },
    { id: 'm3', role: 'assistant', content: 'Trace done; the [gradient mockup](file:///tmp/gradient-mockup.html) shows the target. Fixing now.', toolCalls: [call2, call3], createdAt: t + 2000 },
    { id: 'm4', role: 'tool', content: '', toolResult: { toolCallId: 'gh', output: 'https://github.com/nekko-labs/nekko-agent/pull/1150' }, createdAt: t + 3000 },
    { id: 'm5', role: 'assistant', content: 'The changes are in place and the desktop TypeScript check passes. Next I will verify menu contrast.', toolCalls: [call4], createdAt: t + 4000 },
  ];
  s.agentPlan = steps.map((title, i) => ({ id: 'step_' + (i + 1), title, status: i < 2 ? 'done' : i === 2 ? 'active' : 'pending', note: [call2.input.steps[0].note, call4.input.steps[0].note, call4.input.steps[1].note, undefined][i], createdAt: t, updatedAt: t + 4000 }));
  s.agentPlan[0].verification = { status: 'passed', device: 'macOS', detail: 'Traced both menus against the merged PR.', evidenceUrl: 'https://example.test/evidence/trace' };
  s.agentPlan[2].verification = { status: 'active', device: 'macOS', detail: 'Comparing base and head gradient captures.' };
  f.putCachedSession(s);
  f.store.setState({ planRailOpen: true, prsBySession: { a: [{ url: 'https://github.com/nekko-labs/nekko-agent/pull/1150', owner: 'nekko-labs', repo: 'nekko-agent', number: 1150, title: 'Neutral menus', state: 'open', isDraft: false, additions: 120, deletions: 40, changedFiles: 6, checks: 'failing', checkProgress: { total: 6, completed: 4, pending: 1, failing: 1, unknown: 0, items: [{ name: 'build', state: 'completed', link: null }, { name: 'lint', state: 'completed', link: null }, { name: 'capture (windows)', state: 'failing', link: null }, { name: 'gate', state: 'pending', link: null }, { name: 'daemon', state: 'completed', link: null }, { name: 'CodeQL', state: 'completed', link: null }] } }] } });
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
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({root:{id:'a-pane',kind:'chat',refId:'a'},hero:'a',watermark:1,autoAdd:false,layout:{mode:'focus'},dock:{show:false},agentPanel:{show:true}}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-chat-surface]")'); i++) await sleep(100);
    // A hidden window counts as an inactive app, which pauses every animation
    // (html[data-app-inactive]); keep it active so the sheet's motion is real.
    await run(`(() => { const h = document.documentElement; const off = () => h.removeAttribute('data-app-inactive'); off(); new MutationObserver(off).observe(h, { attributes: true, attributeFilter: ['data-app-inactive'] }); })()`);
    await run(SEED);
    await run(`(async () => { await layoutFixture.store.getState().refreshSessions(); layoutFixture.store.setState({ focusRequest: { sessionId: 'a' } }); })()`);
    await run(`layoutFixture.store.setState({settings:{...layoutFixture.store.getState().settings,theme:'dark',themePreset:'x-blueberry-dark'}}); layoutFixture.store.getState().applyTheme()`);
    await sleep(1200);
    await shot('plan-focused');
    report.anims = await run(`document.getAnimations().map(a => [a.animationName || a.transitionProperty, a.playState, Math.round(a.currentTime), a.effect?.target?.className?.slice?.(0, 40)])`);
    report.sheet = await run(`(() => { const e = document.querySelector('[data-plan-sheet]'); return e && { t: getComputedStyle(e).transform, r: e.getBoundingClientRect().toJSON(), o: getComputedStyle(e.closest('[data-chat-surface]') || e).opacity }; })()`);
    await check('sheet is tucked behind the composer', `(() => { const p = document.querySelector('.plan-sheet-dock'), c = document.querySelector('.composer'); if (!p || !c) return false; const a = p.getBoundingClientRect(), b = c.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 4); return a.bottom > b.top && a.bottom <= b.top + 12 && !!hit && c.contains(hit); })()`);
    await check('right column has no agent plan', `!document.querySelector('[aria-label="Plan and sub-agents"]')?.textContent.includes('Agent plan')`);
    await check('done steps squeezed', `[...document.querySelectorAll('[data-plan-step="done"] [data-plan-more]')].every(e => e.getBoundingClientRect().height < 1)`);
    await check('PR chip on step 2', `!!document.querySelector('[data-plan-step-id="step_2"] [data-plan-chip="pr"]')`);
    await check('verification panel is gone', `!document.querySelector('[data-verification-checklist]')`);
    await check('verification chips on steps 1 and 3', `!!document.querySelector('[data-plan-step-id="step_1"] [data-plan-chip="verify"]') && !!document.querySelector('[data-plan-step-id="step_3"] [data-plan-chip="verify"]')`);
    await check('CI chips on the last verification step', `document.querySelectorAll('[data-plan-step-id="step_3"] [data-plan-chip="ci"]').length === 3 && document.querySelectorAll('[data-plan-chip="ci"]').length === 3`);
    await check('PR card leaves CI to the plan', `!document.querySelector('[data-pr-progress]')?.textContent.includes('CI checks')`);
    await check('design link on step 1', `!!document.querySelector('[data-plan-step-id="step_1"] [data-plan-chip="link"]')`);
    const hover = await run(`(() => { const r = document.querySelector('[data-plan-step-id="step_3"]')?.getBoundingClientRect(); return r ? { x: Math.round(r.x + 40), y: Math.round(r.y + 8) } : { x: 1, y: 1 }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...hover });
    fs.mkdirSync(path.join(out, 'motion'), { recursive: true });
    for (let i = 0; i < 8; i++) { fs.writeFileSync(path.join(out, 'motion', String(i).padStart(3, '0') + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); await sleep(30); }
    await sleep(200);
    await check('hovering the card expands every done step', `[...document.querySelectorAll('[data-plan-step="done"] [data-plan-more]')].every(e => e.getBoundingClientRect().height > 10)`);
    await shot('plan-hover');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    for (let i = 8; i < 14; i++) { fs.writeFileSync(path.join(out, 'motion', String(i).padStart(3, '0') + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); await sleep(30); }
    report.hidden = !win.isVisible(); report.focused = win.isFocused(); report.bounds = win.getBounds();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks, errors: report.errors, success: report.success, anims: report.anims, sheet: report.sheet })); win.destroy(); app.exit(report.success ? 0 : 1); }
});
