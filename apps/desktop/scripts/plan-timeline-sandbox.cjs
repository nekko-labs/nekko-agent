// Plan timeline evidence: the folded plan as dots on a line, the hover card, and
// the switch that turns the line down the left edge. Same chat as
// plan-sheet-sandbox.cjs, captured hidden and off-screen on a throwaway profile.
// Launch: NEKKO_LAYOUT_SANDBOX=plan-timeline-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const writeGif = require('./evidence-gif.cjs');
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
    { id: 'm5', role: 'assistant', content: 'The changes are in place and the desktop TypeScript check passes. Next I will verify menu contrast.', toolCalls: [call4], turnStats: { stop: 'complete' }, createdAt: t + 4000 },
  ];
  s.agentPlan = steps.map((title, i) => ({ id: 'step_' + (i + 1), title, kind: ['build', 'build', 'verify', 'ship'][i], status: i < 2 ? 'done' : i === 2 ? 'active' : 'pending', note: [call2.input.steps[0].note, call4.input.steps[0].note, call4.input.steps[1].note, undefined][i], createdAt: t, updatedAt: t + 4000 }));
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
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({root:${process.env.NEKKO_PLAN_LAYOUT === 'grid' ? `{id:'s1',dir:'row',children:[{id:'a-pane',kind:'chat',refId:'a'},{id:'b-pane',kind:'chat',refId:'b'}],sizes:[0.5,0.5]}` : `{id:'a-pane',kind:'chat',refId:'a'}`},hero:'a',watermark:1,zonesIntro:true,autoAdd:false,layout:{mode:'${process.env.NEKKO_PLAN_LAYOUT || 'focus'}'},dock:{show:false},agentPanel:{show:true}}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-chat-surface]")'); i++) await sleep(100);
    // A hidden window counts as an inactive app, which pauses every animation
    // (html[data-app-inactive]); keep it active so the sheet's motion is real.
    await run(`(() => { const h = document.documentElement; const off = () => h.removeAttribute('data-app-inactive'); off(); new MutationObserver(off).observe(h, { attributes: true, attributeFilter: ['data-app-inactive'] }); })()`);
    await run(SEED);
    await run(`(() => { const f=layoutFixture, prs=f.store.getState().prsBySession.a; f.bridge.listSessionPrs=async()=>prs; f.bridge.getPrInfo=async()=>prs[0]; })()`);
    await run(`layoutFixture.store.getState().refreshSessions()`);
    if (process.env.NEKKO_PLAN_LAYOUT !== 'grid') await run(`layoutFixture.store.setState({ focusRequest: { sessionId: 'a' } })`);
    await run(`layoutFixture.store.setState({settings:{...layoutFixture.store.getState().settings,theme:'dark',themePreset:'x-blueberry-dark'}}); layoutFixture.store.getState().applyTheme()`);
    await sleep(1200);
    await run(`(() => { const style = document.createElement('style'); style.textContent = '.plan-sheet { animation: none !important; }'; document.head.append(style); })()`);
    const frames = async (name, count, gap) => { const list = []; for (let i = 0; i < count; i++) { const png = (await win.capturePage(undefined, { stayHidden: true })).toPNG(); list.push(png); fs.mkdirSync(path.join(out, name), { recursive: true }); fs.writeFileSync(path.join(out, name, String(i).padStart(3, '0') + '.png'), png); await sleep(gap); } const gif = path.join(out, name + '.gif'); writeGif(gif, list, Math.round(1000 / gap)); report.captures.push(gif); };
    const lineAngle = `(() => { const l = document.querySelector('.plan-timeline-line'); return l && getComputedStyle(l).transform; })()`;
    await check('folded plan is a horizontal timeline', `!!document.querySelector('[data-plan-timeline="horizontal"]')`);
    await check('one dot per step, in order, with its status', `JSON.stringify([...document.querySelectorAll('[data-plan-timeline] [data-tl-dot]')].map(e => e.dataset.tlDot + ':' + e.dataset.planDot)) === JSON.stringify(['step_1:done','step_2:done','step_3:active','step_4:pending'])`);
    await check('dots sit on the line', `(() => { const l = document.querySelector('.plan-timeline-line').getBoundingClientRect(); return [...document.querySelectorAll('[data-tl-dot]')].every(d => { const r = d.getBoundingClientRect(); return Math.abs((r.top + r.height / 2) - (l.top + l.height / 2)) < 2; }); })()`);
    await check('the line fills to the last finished step', `(() => { const f = document.querySelector('.plan-timeline-line[data-filled]').getBoundingClientRect(), d = document.querySelector('[data-tl-dot="step_2"]').getBoundingClientRect(); return Math.abs(f.right - (d.left + d.width / 2)) < 2; })()`);
    await check('the step being worked stays readable under the dots', `JSON.stringify([...document.querySelectorAll('[data-plan-current] [data-plan-step-id]')].map(e => e.dataset.planStepId)) === '["step_3"]'`);
    await check('folded dots: rocket while building, dotted ring pending', `!!document.querySelector('[data-tl-dot="step_3"] .plan-mark-rocket') && !!document.querySelector('[data-tl-dot="step_4"] [data-plan-pending]')`);
    await shot('timeline-folded');
    const dot = await run(`(() => { const r = document.querySelector('[data-tl-dot="step_1"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...dot });
    await sleep(300);
    report.card = await run(`({ card: document.querySelector('.plan-timeline-card')?.textContent, hovered: document.querySelector('[data-tl-dot]:hover')?.dataset.tlDot })`);
    await check('hovering a dot shows that step', `(() => { const c = document.querySelector('.plan-timeline-card'); return !!c && c.textContent.includes('Step 1 of 4') && c.textContent.includes('Trace menus') && c.textContent.includes('Verified on macOS'); })()`);
    await check('the card sits above its dot and on screen', `(() => { const c = document.querySelector('.plan-timeline-card').getBoundingClientRect(), d = document.querySelector('[data-tl-dot="step_1"]').getBoundingClientRect(); return c.bottom <= d.top && c.left >= 0 && c.right <= innerWidth; })()`);
    await shot('timeline-hover');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await sleep(200);
    await check('leaving the dot hides the card', `!document.querySelector('.plan-timeline-card')`);
    // Open: the line turns down the left edge and the rows slide in.
    await run(`document.querySelector('.plan-sheet-toggle').click()`);
    await check('the line turns from flat to upright and the rows slide in from the left', `(() => { const kf = document.getAnimations().map(a => [a.effect.target, a.effect.getKeyframes()]); const line = kf.find(([t]) => t.classList?.contains('plan-timeline-line')); const text = kf.filter(([t]) => t.hasAttribute?.('data-tl-text')); return !!line && line[1][0].transform.includes('rotate(0deg)') && line[1][1].transform === 'rotate(90deg)' && text.length === 4 && text.every(([, k]) => k[0].transform.includes('translateX(-16px)')); })()`);
    await sleep(600);
    // Replay it at a tenth of the speed so the frames show the turn.
    await run(`document.querySelector('.plan-sheet-toggle').click()`);
    await sleep(500);
    await win.webContents.debugger.sendCommand('Animation.enable');
    await win.webContents.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: 0.1 });
    await run(`document.querySelector('.plan-sheet-toggle').click()`);
    await frames('timeline-open', 24, 60);
    await win.webContents.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: 1 });
    await sleep(300);
    await check('open plan is a vertical timeline with every step in order', `!!document.querySelector('[data-plan-timeline="vertical"]') && JSON.stringify([...document.querySelectorAll('[data-plan-timeline] [data-plan-step-id]')].map(e => e.dataset.planStepId)) === JSON.stringify(['step_1','step_2','step_3','step_4'])`);
    report.openTransform = await run(lineAngle);
    await check('the line runs down the left, through each mark', `(() => { const l = document.querySelector('.plan-timeline-line').getBoundingClientRect(); return l.height > l.width && [...document.querySelectorAll('[data-plan-timeline] [data-tl-dot]')].every(d => { const r = d.getBoundingClientRect(); return Math.abs((r.left + r.width / 2) - (l.left + l.width / 2)) < 2; }); })()`);
    // The line must read between every pair of marks, not just peek out as dashes.
    report.openGaps = await run(`(() => { const d = [...document.querySelectorAll('[data-plan-timeline] [data-tl-dot]')].map(e => e.getBoundingClientRect()); return d.slice(1).map((r, i) => Math.round(r.top - d[i].bottom)); })()`);
    await check('the open line spans from the first mark to the last', `(() => { const l = document.querySelector('.plan-timeline-line').getBoundingClientRect(), d = [...document.querySelectorAll('[data-plan-timeline] [data-tl-dot]')].map(e => e.getBoundingClientRect()); const c = r => r.top + r.height / 2; return Math.abs(l.top - c(d[0])) < 2 && Math.abs(l.bottom - c(d.at(-1))) < 2; })()`);
    await check('the line crosses every gap between marks', `(() => { const l = document.querySelector('.plan-timeline-line').getBoundingClientRect(), d = [...document.querySelectorAll('[data-plan-timeline] [data-tl-dot]')].map(e => e.getBoundingClientRect()); return d.slice(1).every((b, i) => { const a = d[i], y = (a.bottom + b.top) / 2, x = a.left + a.width / 2; return l.top <= a.bottom && l.bottom >= b.top && Math.abs(x - (l.left + l.width / 2)) < 2 && y > l.top; }); })()`);
    await check('the line shows at least 10px between every pair of marks when open', `(() => { const d = [...document.querySelectorAll('[data-plan-timeline] [data-tl-dot]')].map(e => e.getBoundingClientRect()); return d.slice(1).every((r, i) => r.top - d[i].bottom >= 10); })()`);
    await check('open marks: check when done, rocket while building, dotted ring pending', `!!document.querySelector('[data-plan-step-id="step_1"] .text-success') && !!document.querySelector('[data-plan-step-id="step_3"] .plan-mark-rocket') && !!document.querySelector('[data-plan-step-id="step_4"] [data-plan-pending]')`);
    await check('rows sit right of the line', `(() => { const l = document.querySelector('.plan-timeline-line').getBoundingClientRect(); return [...document.querySelectorAll('[data-tl-text]')].every(t => t.getBoundingClientRect().left > l.right); })()`);
    await check('no animation is left running', `document.getAnimations().filter(a => a.playState === 'running' && !/plan-working|ripple/.test(a.animationName || '') && a.effect?.getTiming?.().iterations !== Infinity).length === 0`);
    await shot('timeline-open');
    await run(`document.querySelector('.plan-sheet-toggle').click()`);
    await frames('timeline-fold', 12, 25);
    await sleep(300);
    await check('the folded line spans from the first dot to the last', `(() => { const l = document.querySelector('.plan-timeline-line').getBoundingClientRect(), d = [...document.querySelectorAll('[data-tl-dot]')].map(e => e.getBoundingClientRect()); const c = r => r.left + r.width / 2; return Math.abs(l.left - c(d[0])) < 2 && Math.abs(l.right - c(d.at(-1))) < 2; })()`);
    await check('folding turns it back into dots', `!!document.querySelector('[data-plan-timeline="horizontal"]')`);
    // A dot click opens the plan at that step.
    await run(`document.querySelector('[data-tl-dot="step_4"]').click()`);
    await sleep(500);
    await check('clicking a dot opens the plan', `!!document.querySelector('[data-plan-timeline="vertical"]')`);
    await run(`document.querySelector('.plan-sheet-toggle').click()`);
    await sleep(400);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await run(`document.querySelector('.plan-sheet-toggle').click()`);
    await sleep(40);
    report.reducedAnims = await run(`document.getAnimations().map(a => a.effect?.getKeyframes?.().map(k => k.transform).filter(Boolean)).flat()`);
    await check('reduced motion moves nothing, only fades', `document.getAnimations().length > 0 && document.getAnimations().every(a => !(a.effect?.getKeyframes?.() ?? []).some(k => k.transform && k.transform !== 'none'))`);
    await sleep(400);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await run(`document.querySelector('.plan-sheet-toggle').click()`);
    await sleep(400);
    // Light theme, and the phone width the Local Web UI shares.
    await run(`layoutFixture.store.setState({settings:{...layoutFixture.store.getState().settings,theme:'light',themePreset:undefined}}); layoutFixture.store.getState().applyTheme()`);
    await sleep(400);
    await shot('timeline-folded-light');
    win.setContentSize(390, 844);
    await run(`layoutFixture.showComposer('composer')`);
    await sleep(800);
    await shot('timeline-mobile');
    report.mobile = await run(`({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })`);
    await check('no sideways scroll at phone width', `document.documentElement.scrollWidth <= innerWidth`);
    report.hidden = !win.isVisible(); report.focused = win.isFocused(); report.bounds = win.getBounds();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks, errors: report.errors, success: report.success, openTransform: report.openTransform, openGaps: report.openGaps })); win.destroy(); app.exit(report.success ? 0 : 1); }
});
