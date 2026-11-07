// The plan sheet's task and PR chips wearing their live GitHub state, and the
// Agents label leading the sub-agent cards. Hidden, off-screen, non-focusable,
// throwaway profile. Launch: NEKKO_LAYOUT_SANDBOX=plan-chip-status-sandbox.cjs
// node apps/desktop/scripts/layout-evidence-integration.cjs (NEKKO_TEST_SOURCE=<base checkout> for "before").
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
  const repo = 'https://github.com/nekko-labs/nekko-agent';
  const issues = {
    [repo + '/issues/1941']: { state: 'closed', stateReason: 'completed', title: 'Merge-all native acceptance' },
    [repo + '/issues/2030']: { state: 'open', stateReason: null, title: 'Visual acceptance without bypass' },
    [repo + '/issues/1990']: { state: 'closed', stateReason: 'not_planned', title: 'Retire the old runner' },
  };
  f.bridge.getIssueInfo = async url => issues[url] ? { kind: 'issue', url, owner: 'nekko-labs', repo: 'nekko-agent', number: Number(url.split('/').pop()), ...issues[url] } : null;
  const pr = { url: repo + '/pull/2031', owner: 'nekko-labs', repo: 'nekko-agent', number: 2031, title: 'Land white icon', state: 'open', isDraft: false, additions: 40, deletions: 8, changedFiles: 3, checks: 'failing' };
  f.bridge.listSessionPrs = async () => [pr];
  s.title = 'Merge-all acceptance';
  s.messages = [
    { id: 'm1', role: 'user', content: 'Finish ' + Object.keys(issues).join(' and ') + ' without bypass.', createdAt: t },
    { id: 'm2', role: 'assistant', content: 'Opening the PR.', toolCalls: [{ id: 'c0', name: 'TodoWrite', input: { todos: [{ content: 'Land white icon PR', status: 'in_progress' }] } }, { id: 'c1', name: 'bash', input: { command: 'gh pr create --fill' } }], createdAt: t + 1000 },
    { id: 'm3', role: 'user', content: '', toolResult: { toolCallId: 'c1', output: pr.url, isError: false }, createdAt: t + 1100 },
    { id: 'm4', role: 'assistant', content: 'Sub-agents are checking each surface.', turnStats: { stop: 'complete' }, createdAt: t + 2000 },
  ];
  const step = (id, title, status) => ({ id, title, kind: 'build', status, createdAt: t, updatedAt: Date.now() });
  s.agentPlan = [step('step_1', 'Verify cold paint', 'done'), step('step_2', 'Fix summary alerts', 'done'), step('step_3', 'Land white icon PR', 'active')];
  const kid = (id, title, reply) => ({ ...s, id, title, parentSessionId: 'a', agentPlan: undefined, createdAt: t + 2000, messages: [
    { id: id + 'u', role: 'user', content: title, createdAt: t + 2000 },
    ...(reply ? [{ id: id + 'a', role: 'assistant', content: reply, createdAt: t + 3000 }] : []),
  ] });
  f.records.push(kid('k1', 'Verify #2013 cold paint', 'Done.'), kid('k2', 'Fix #2018 summary alerts', 'Done.'), kid('k3', 'Gather phone tuck evidence', 'Done.'), kid('k4', 'Repair native baseline tests', 'Done.'));
  f.records.forEach(f.putCachedSession);
  f.store.setState({ prsBySession: { ...f.store.getState().prsBySession, a: [pr] } });
})()`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const shot = async (name, rect) => { await sleep(100); const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const sheetShot = async name => {
    const r = await run(`(() => { const r = document.querySelector('[data-plan-sheet]')?.getBoundingClientRect(); return r ? { x: Math.max(0, Math.floor(r.x) - 8), y: Math.max(0, Math.floor(r.y) - 8), width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 } : null; })()`);
    if (r) await shot(name, r);
  };
  const check = async (name, expression) => { const value = await run(expression).catch(() => false); report.checks.push({ name, value }); if (!before && !value) throw Error(name); };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 200)); });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({root:{id:'a-pane',kind:'chat',refId:'a'},hero:'a',watermark:1,zonesIntro:true,autoAdd:false,layout:{mode:'focus'},dock:{show:false},agentPanel:{show:false}}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-grid-cell]")'); i++) await sleep(100);
    await sleep(700);
    await run(`(() => { const h = document.documentElement; const off = () => h.removeAttribute('data-app-inactive'); off(); new MutationObserver(off).observe(h, { attributes: true, attributeFilter: ['data-app-inactive'] }); })()`);
    await run(`(() => { const style = document.createElement('style'); style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'; document.head.append(style); })()`);
    await run(SEED);
    await run(`layoutFixture.store.getState().refreshSessions()`);
    await sleep(700);
    await run(`layoutFixture.store.setState({ focusRequest: { sessionId: 'a' } })`);
    for (let i = 0; i < 50 && await run(`document.querySelectorAll('[data-plan-sheet] [data-subagent-card]').length`) < 4; i++) await sleep(200);
    await sleep(1500);
    report.chips = await run(`[...document.querySelectorAll('[data-plan-sheet] [data-plan-chip]')].map(c => [c.dataset.planChip, c.dataset.issueState || c.dataset.prStatus || '', c.textContent.trim()])`);
    await sheetShot('plan-sheet-open');
    await check('the open task is green, the done one purple', `(() => { const tone = s => getComputedStyle(document.querySelector('[data-issue-state="' + s + '"] > span')).color; return tone('record') !== tone('check-circle') && tone('record') !== tone('ban'); })()`);
    await check('each GitHub task wears its live state', `['record', 'check-circle', 'ban'].every(s => document.querySelector('[data-plan-chip="project"][data-issue-state="' + s + '"] [data-gf-icon="' + s + '"]'))`);
    await check('the PR chip wears the Gentleface PR glyph for its state', `!!document.querySelector('[data-plan-chip="pr"][data-pr-status="open"] [data-gf-icon="git-pull-request"]')`);
    await check('the Agents label leads the sub-agent cards', `(() => { const head = document.querySelector('[data-plan-subagents] .plan-sheet-agents-head'); const card = document.querySelector('[data-plan-subagents] [data-subagent-card]'); return !!head?.querySelector('[data-gf-icon="bots"]') && /Agents/.test(head.textContent) && head.getBoundingClientRect().right <= card.getBoundingClientRect().left; })()`);
    await run(`document.querySelector('[data-plan-sheet] .plan-sheet-toggle')?.click()`);
    await sleep(600);
    await sheetShot('plan-sheet-folded');
    report.hidden = !win.isVisible(); report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ chips: report.chips, checks: report.checks, errors: report.errors, success: report.success })); win.destroy(); app.exit(report.success ? 0 : 1); }
});
