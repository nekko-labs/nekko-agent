// Plan sheet evidence for a Claude Agent chat whose Claude Code wrote no plan:
// the activity plan of its latest request (send, explore, build, verify, ship)
// and the PR it opened on the Ship step. Captured hidden and off-screen on a
// throwaway profile.
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
  const f = layoutFixture, t = Date.now() - 600000, s = f.records[0];
  const st = f.store.getState();
  // The chat runs on a Claude Agent: Claude Code, not Nekko, runs its turns.
  f.store.setState({ providers: st.providers.map(p => p.id === s.providerId ? { ...p, kind: "claude-code", label: "Claude Agent" } : p) });
  // How Claude Code opens a PR: its own Bash tool, in its worktree, the body
  // in a heredoc, the output trimmed.
  const body = ['$(cat <<' + "'EOF'", '## Summary', '- Neutral menus; one gradient', 'EOF', ')'].join(String.fromCharCode(10));
  const create = { id: 'gh', name: 'Bash', input: { command: 'cd C:/code/app/.worktrees/menus && gh pr create --title "Neutral menus" --body "' + body + '" 2>&1 | tail -5' } };
  const tool = (id, name, input) => ({ id, name, input });
  const NL = String.fromCharCode(10);
  s.messages = [
    { id: "m1", role: "user", content: "nekko agent" + NL + "- look at why the menus look washed out", createdAt: t },
    { id: "m2", role: "assistant", content: "They use the muted token on a tinted surface.", createdAt: t + 1000 },
    { id: "m3", role: "user", content: "nekko agent" + NL + "- fix the menus and the new chat gradient, then open a PR", createdAt: t + 2000 },
    { id: "m4", role: "assistant", content: "Looking at the menu styles.", toolCalls: [tool("g1", "Grep", { pattern: "menu" }), tool("r1", "Read", { file_path: "styles.css" }), tool("r2", "Read", { file_path: "Menu.tsx" })], createdAt: t + 3000 },
    { id: "m5", role: "assistant", content: "Fixing both.", toolCalls: [tool("e1", "Edit", {}), tool("e2", "Edit", {}), tool("e3", "Edit", {})], createdAt: t + 4000 },
    { id: "m6", role: "assistant", content: "Running the tests.", toolCalls: [tool("t1", "Bash", { command: "npx vitest run src/Menu.test.tsx" })], createdAt: t + 5000 },
    { id: "m7", role: "assistant", content: "Opening the PR.", toolCalls: [create], createdAt: t + 6000 },
    { id: "m8", role: "tool", content: "", toolResult: { toolCallId: "gh", output: "https://github.com/nekko-labs/nekko-agent/pull/1150" }, createdAt: t + 7000 },
  ];
  delete s.agentPlan;
  s.activeRun = { id: "r1", startedAt: t + 2000 };
  f.putCachedSession(s);
  f.store.setState({ prsBySession: { a: [{ url: "https://github.com/nekko-labs/nekko-agent/pull/1150", owner: "nekko-labs", repo: "nekko-agent", number: 1150, title: "Neutral menus", state: "open", isDraft: false, additions: 120, deletions: 40, changedFiles: 6, checks: "pending", checkProgress: { total: 3, completed: 2, pending: 1, failing: 0, unknown: 0, items: [{ name: "build", state: "completed", link: null }, { name: "lint", state: "completed", link: null }, { name: "gate", state: "pending", link: null }] } }] } });
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
    await run(`layoutFixture.store.getState().refreshSessions()`);
    if (process.env.NEKKO_PLAN_LAYOUT !== 'grid') await run(`layoutFixture.store.setState({ focusRequest: { sessionId: 'a' } })`);
    await run(`layoutFixture.store.setState({settings:{...layoutFixture.store.getState().settings,theme:'dark',themePreset:'x-blueberry-dark'}}); layoutFixture.store.getState().applyTheme()`);
    await sleep(1200);
    for (let i = 0; i < 30 && !await run(`!!document.querySelector('[data-chat-surface]')?.textContent.includes('Opening the PR')`); i++) await sleep(100);
    // A hidden window can hand back its last painted frame: capture once to flush it.
    await sleep(2500); await win.capturePage(undefined, { stayHidden: true }); await sleep(800);
    await shot('plan-folded');
    report.anims = await run(`document.getAnimations().map(a => [a.animationName || a.transitionProperty, a.playState, Math.round(a.currentTime), a.effect?.target?.className?.slice?.(0, 40)])`);
    report.sheet = await run(`(() => { const e = document.querySelector('[data-plan-sheet]'); return e && { t: getComputedStyle(e).transform, r: e.getBoundingClientRect().toJSON(), o: getComputedStyle(e.closest('[data-chat-surface]') || e).opacity }; })()`);
    await check('a Claude Agent chat shows the sheet', `!!document.querySelector('[data-plan-sheet]')`);
    await check('the phase Claude Code is in is the folded line', `document.querySelector('[data-plan-sheet]')?.textContent.includes('Open a pull request')`);
    await check('the PR Claude Code opened shows', `!!document.querySelector('[data-plan-sheet] [data-plan-chip="pr"]')`);
    await run(`document.querySelector('.plan-sheet-fold')?.click()`);
    await sleep(1500);
    await check('the PR sits on the Ship step', `!!document.querySelector('[data-plan-step-id="phase:ship"] [data-plan-chip="pr"]')`);
    await check('one step per phase, not per prompt', `document.querySelectorAll('[data-plan-step-id]').length === 5 && !document.querySelector('[data-plan-sheet]').textContent.includes('Ask Claude Code')`);
    await win.capturePage(undefined, { stayHidden: true }); await sleep(800);
    await shot('plan-open');
    report.hidden = !win.isVisible(); report.focused = win.isFocused(); report.bounds = win.getBounds();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks, errors: report.errors, success: report.success, anims: report.anims, sheet: report.sheet })); win.destroy(); app.exit(report.success ? 0 : 1); }
});
