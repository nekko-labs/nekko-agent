// Compact plan row journey: actual App, stub bridge, hidden isolated Electron.
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
const SEED = `(() => {
  const f = layoutFixture, t = Date.now() - 600000, s = f.records[0];
  const plan = (steps) => ({ id: 'u' + steps.map(x => x.status).join(''), name: 'update_plan', input: { steps } });
  const steps = ['Trace menus, tab selection, and the merged background change', 'Fix neutral menus, active-agent reveal, and new-chat-only gradient', 'Run focused tests and inspect sandbox screenshots and motion', 'Update specs, publish issue and PR with evidence, queue merge'];
  const call1 = plan(steps.map((title, i) => ({ title, status: i ? 'pending' : 'active' })));
  const call2 = plan([{ id: 'step_1', status: 'done', note: 'PR #1123 merged; the separate pixel-wave layer was unchanged.' }, { id: 'step_2', status: 'active' }]);
  const call3 = { id: 'gh', name: 'bash', input: { command: 'gh pr create --fill' } };
  const call4 = plan([{ id: 'step_2', status: 'done', note: 'Implemented focused changes; desktop TypeScript check passes.' }, { id: 'step_3', status: 'active', note: 'Base and head gradient captures taken in isolated hidden Electron windows.' }]);
  s.messages = [
    { id: 'm1', role: 'user', content: 'Fix the menus and the new chat gradient. https://linear.app/nekko/issue/NEK-412/compact-plan', createdAt: t },
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
  const check = async (name, expression) => { const value = await run(expression); report.checks.push({ name, value }); if (!value) throw Error(name); };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('nekko.commandWall', JSON.stringify({root:{id:'a-pane',kind:'chat',refId:'a'},hero:'a',watermark:1,zonesIntro:true,autoAdd:false,layout:{mode:'focus'},dock:{show:false},agentPanel:{show:true}}));" });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-chat-surface]")'); i++) await sleep(100);
    await run(SEED);
    await run("(() => { const f=layoutFixture, prs=f.store.getState().prsBySession.a; f.bridge.listSessionPrs=async()=>prs; f.bridge.getPrInfo=async()=>prs[0]; f.bridge.openPath=async url=>{f.lastOpen=url}; })()");
    await run("layoutFixture.store.getState().refreshSessions(); layoutFixture.store.setState({focusRequest:{sessionId:'a'}})");
    await sleep(1200);
    await run("(() => { const style = document.createElement('style'); style.textContent = '.plan-sheet { animation: none !important; }'; document.head.append(style); })()");
    await shot('compact-plan-desktop');
    await run("layoutFixture.store.setState({settings:{...layoutFixture.store.getState().settings,theme:'light'}});layoutFixture.store.getState().applyTheme()");
    await sleep(250);
    await shot('compact-plan-light');
    await run("layoutFixture.store.setState({settings:{...layoutFixture.store.getState().settings,theme:'dark'}});layoutFixture.store.getState().applyTheme()");
    await sleep(250);
    if (!process.env.NEKKO_TEST_SOURCE) {
      await check('notes and report detail are absent from rows', "!document.querySelector('.plan-sheet-more > p') && !document.querySelector('[data-plan-sheet]').innerText.includes('Base and head gradient captures')");
      await check('status and safe evidence remain on their step', "!!document.querySelector('[data-plan-step-id=step_1] [aria-label=\"Verified on macOS, open evidence\"]') && !!document.querySelector('[data-plan-step-id=step_3] [data-plan-check=active]')");
      await check('chips share the title line', "[...document.querySelectorAll('.plan-row-inline')].every(e => {const row=e.closest('.plan-row-line').getBoundingClientRect(); return Math.abs(row.top-e.getBoundingClientRect().top)<3;})");
    }
    win.setContentSize(390, 844);
    await run("layoutFixture.showComposer('composer')");
    await sleep(800);
    report.narrowRows = await run("[...document.querySelectorAll('[data-plan-step-id]')].map(e=>({id:e.dataset.planStepId,text:e.innerText,items:e.querySelectorAll('[data-plan-item]').length}))");
    await shot('compact-plan-narrow');
    if (!process.env.NEKKO_TEST_SOURCE) {
      await check('narrow rows show accurate overflow counts', "[...document.querySelectorAll('.plan-row-content')].filter(e=>e.querySelectorAll('[data-plan-item]').length).every(e=>{const n=e.querySelectorAll('[data-plan-item][data-overflowed]').length;return n>0 && e.querySelector('[data-plan-overflow]')?.textContent==='+'+n;})");
      await check('no horizontal overflow', "document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.plan-row-line')].every(e=>e.scrollWidth <= e.clientWidth+1)");
      await run("document.querySelector('[data-plan-step-id=step_1] [data-plan-overflow]').click()");
      await sleep(250);
      await check('mouse reveals only its row', "document.querySelectorAll('[data-plan-more]:not([hidden])').length===1 && !!document.querySelector('[data-plan-step-id=step_1] [data-plan-more]:not([hidden])')");
      await run("document.querySelector('[data-plan-step-id=step_1] [data-plan-more] [data-plan-chip=project]').click()");
      await check('expanded task chip keeps navigation', "layoutFixture.lastOpen.includes('linear.app/nekko/issue/NEK-412')");
      await run("document.querySelector('[data-plan-step-id=step_1] [data-plan-overflow]').click(); document.querySelector('[data-plan-step-id=step_1] [data-plan-check]').click()");
      await check('reported check opens safe evidence', "layoutFixture.lastOpen==='https://example.test/evidence/trace'");
      await run("document.querySelector('[data-plan-step-id=step_3] [data-plan-overflow]').focus()");
      const frames = [];
      for (let i=0;i<4;i++) { frames.push((await win.capturePage(undefined,{stayHidden:true})).toPNG()); await sleep(70); }
      for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({type,keyCode:type==='char'?'\r':'Enter'});
      for (let i=0;i<12;i++) { frames.push((await win.capturePage(undefined,{stayHidden:true})).toPNG()); await sleep(70); }
      writeGif(path.join(out,'compact-plan-expand.gif'),frames,7);
      await check('Enter reveals remaining chips on only that row', "document.querySelector('[data-plan-step-id=step_3] [data-plan-overflow]').getAttribute('aria-expanded')==='true' && document.querySelectorAll('[data-plan-more]:not([hidden])').length===1 && document.querySelector('[data-plan-step-id=step_3] [data-plan-more]').querySelectorAll('[data-plan-chip=ci]').length===3");
      await shot('compact-plan-expanded');
      await run("[...document.querySelectorAll('[data-plan-step-id=step_3] [data-plan-more] [data-plan-chip=ci]')].at(-1).click()");
      await check('CI chip keeps its checks link', "layoutFixture.lastOpen==='https://github.com/nekko-labs/nekko-agent/pull/1150/checks'");
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await check('reduced motion disables reveal and press transitions', "getComputedStyle(document.querySelector('[data-plan-step-id=step_3] [data-plan-more]')).animationName==='none' && getComputedStyle(document.querySelector('[data-plan-overflow]')).transitionDuration==='0s'");
      await run("document.querySelector('[data-plan-step-id=step_2] [data-plan-overflow]').click()");
      await sleep(250);
      await run("document.querySelector('[data-plan-step-id=step_2] [data-plan-more] [data-plan-chip=pr]').focus()");
      await sleep(250);
      await check('PR actions remain visible and reachable inside viewport', "(() => {const a=document.querySelector('[data-plan-step-id=step_2] [data-plan-more] [data-pr-act=approve]'),r=a.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===a;})()");
      await run("document.querySelector('[data-plan-step-id=step_2] [data-plan-more] [data-plan-chip=pr]').click()");
      await check('PR chip keeps navigation', "layoutFixture.lastOpen==='https://github.com/nekko-labs/nekko-agent/pull/1150'");
      await run("document.querySelector('[data-plan-step-id=step_2] [data-plan-overflow]').click()");
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
      await run("document.querySelector('[data-plan-step-id=step_3] [data-plan-overflow]').focus()");
      for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({type,keyCode:type==='char'?' ':'Space'});
      await sleep(250);
      await check('Space collapses overflow and retains focus', "document.querySelector('[data-plan-step-id=step_3] [data-plan-overflow]').getAttribute('aria-expanded')==='false' && document.activeElement.hasAttribute('data-plan-overflow')");
      win.setContentSize(1440,900);
      await sleep(500);
      await check('resizing recomputes fit', "[...document.querySelectorAll('.plan-row-inline')].some(e=>e.querySelector('[data-plan-item]:not([hidden])'))");
      await run("document.querySelector('.plan-sheet-toggle').click()");
      await sleep(250);
      await check('whole plan folding still works', "!!document.querySelector('[data-plan-sheet][data-folded]')");
    }
    report.hidden = !win.isVisible(); report.focused = win.isFocused(); report.bounds = win.getBounds();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    report.success = true;
  } catch(e) { report.errors.push(String(e.stack || e)); report.success=false; }
  finally { fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report)); win.destroy(); app.exit(report.success?0:1); }
});
