// PR lifecycle evidence (#1812): a saved chat where the agent opened a draft
// PR, marked it ready, had a merge fail, then asked for a merge that GitHub
// later completed; each step sits where it happened. Captured wide and narrow,
// again after a reload from the same saved messages, and while a turn streams
// its own ready step. Hidden, off-screen, non-focusable, throwaway profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], captures: [], errors: [] };
const URL_ = 'https://github.com/nekko-labs/nekko-agent/pull/1812';
const SEED = `(() => {
  const f = layoutFixture, s = f.records[0], t = Date.now() - 900000;
  const bash = (id, command) => ({ id, name: 'Bash', input: { command } });
  let n = 0;
  const step = (id, command, output, isError) => [
    { id: 'a_' + id, role: 'assistant', content: '', toolCalls: [bash(id, command)], createdAt: t + (n += 10000) },
    { id: 't_' + id, role: 'tool', content: '', toolResult: { toolCallId: id, output, isError }, createdAt: t + (n += 10000) },
  ];
  s.messages = [
    { id: 'u1', role: 'user', content: 'Ship the lifecycle change as a draft first, then land it.', createdAt: t },
    ...step('create', 'cd /w && gh pr create --draft --fill', '${URL_}'),
    { id: 'n1', role: 'assistant', content: 'Opened it as a draft while the checks run.', createdAt: t + (n += 10000) },
    ...step('ready', 'gh pr ready 1812', '✓ Pull request nekko-labs/nekko-agent#1812 is marked as "ready for review"'),
    ...step('fail', 'gh pr merge 1812 --auto', 'GraphQL: Pull request is not mergeable', true),
    ...step('merge', 'gh pr merge 1812 --auto', '(Bash completed with no output)'),
    { id: 'done', role: 'assistant', content: 'Merge requested; the queue lands it once gate is green.', createdAt: t + (n += 10000) },
  ];
  f.putCachedSession(s);
  f.store.setState({ prsBySession: { a: [{ url: '${URL_}', owner: 'nekko-labs', repo: 'nekko-agent', number: 1812, title: 'Keep PR lifecycle interactions inline in agent chats', state: 'merged', mergedAt: new Date(t + n + 5000).toISOString(), isDraft: false, additions: 420, deletions: 60, changedFiles: 9, checks: 'passing' }] } });
  f.emitAgent({ type: 'session_meta', sessionId: s.id });
})()`;
const EVENTS = `[...document.querySelectorAll('[data-chat-surface] [data-pr-event]')].map(e => e.dataset.prEvent + ':' + e.textContent.replace(/\\s+/g, ' ').trim().slice(-26))`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => { await win.capturePage(undefined, { stayHidden: true }); await sleep(600); const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, expression) => { const value = await run(expression); report.checks.push({ name, value }); if (!process.env.NEKKO_TEST_SOURCE && !value) throw Error(name); };
  const open = async () => {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await run('layoutFixture.showRetry()'); await sleep(700);
    await run(SEED); await sleep(1500);
    for (let i = 0; i < 30 && !await run(`!!document.querySelector('[data-chat-surface]')?.textContent.includes('Merge requested;')`); i++) await sleep(100);
  };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await open();
    report.saved = await run(EVENTS);
    await check('every confirmed step, in order; the failed merge adds nothing', `JSON.stringify(${EVENTS}.map(e => e.split(':')[0])) === JSON.stringify(['created-draft','ready','merge-requested','merged'])`);
    await check('the requested merge never reads as merged', `![...document.querySelectorAll('[data-pr-event="merge-requested"]')].some(e => /PR merged/.test(e.textContent))`);
    await shot('saved-wide');
    win.setContentSize(460, 900); await sleep(900);
    await check('narrow: every step label stays whole on one line', `[...document.querySelectorAll('[data-chat-surface] [data-pr-event] .whitespace-nowrap')].every(e => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().height < 24)`);
    await shot('saved-narrow');
    win.setContentSize(1200, 900);
    // Reload: the same saved messages draw the same steps in the same places.
    await open();
    report.reloaded = await run(EVENTS);
    await check('a reload draws the same steps', `JSON.stringify(${EVENTS}) === ${JSON.stringify(JSON.stringify(report.saved))}`);
    await shot('reloaded-wide');
    // Streaming: a running turn takes a ready step; it shows before the turn is saved.
    await run(`(() => { const f = layoutFixture, s = f.records[0];
      s.messages = [...s.messages.slice(0, 4), { id: 'u2', role: 'user', content: 'Checks look green. Mark it ready and land it.', createdAt: s.messages[3].createdAt + 1000 }];
      f.putCachedSession({ ...s }); f.store.setState({ prsBySession: { a: [{ ...f.store.getState().prsBySession.a[0], state: 'open', isDraft: true, mergedAt: undefined }] } });
      f.emitAgent({ type: 'session_meta', sessionId: s.id }); })()`);
    await sleep(600);
    await run(`layoutFixture.emit({type:'text',delta:'Checks are green; marking it ready.'})`); await sleep(150);
    await run(`layoutFixture.emit({type:'tool_call',call:{id:'live_ready',name:'Bash',input:{command:'gh pr ready 1812'}}})`); await sleep(150);
    await run(`layoutFixture.emit({type:'tool_result',result:{toolCallId:'live_ready',output:'✓ Pull request nekko-labs/nekko-agent#1812 is marked as "ready for review"'}})`); await sleep(150);
    await run(`layoutFixture.emit({type:'text',delta:'Now asking for the merge.'})`); await sleep(900);
    report.streaming = await run(EVENTS);
    await check('the streaming turn shows its ready step before it is saved, under the saved draft card', `JSON.stringify(${EVENTS}.map(e => e.split(':')[0])) === JSON.stringify(['open','ready'])`);
    await shot('streaming');
    report.hidden = !win.isVisible(); report.focused = win.isFocused(); report.bounds = win.getBounds();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks, saved: report.saved, reloaded: report.reloaded, streaming: report.streaming, errors: report.errors.slice(0, 8), success: report.success, hidden: report.hidden, bounds: report.bounds })); win.destroy(); app.exit(report.success ? 0 : 1); }
});
