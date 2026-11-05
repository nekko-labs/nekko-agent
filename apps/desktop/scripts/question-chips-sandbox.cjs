// Visual evidence for PR #1668: the "Do it here / In a subagent" chips stay
// visible under a QuestionCard even when the composer is empty. Before: the
// chips only showed once there was a draft (or a ghost), so under a question
// with an empty composer the routing choice was invisible. After: the chips
// sit directly under the QuestionCard whenever a question is open, above
// PrWatchContinuation.
//
// Run through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_SANDBOX=question-chips-sandbox.cjs. NEKKO_TEST_SOURCE picks a
// different checkout's renderer (used for the baseline shots). Hidden,
// non-focusable, off-screen; captures with stayHidden so no pixels reach any
// display.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { captures: [], facts: {}, errors: [] };
// A two-option question, concrete enough to read in the shot without leaning
// on domain knowledge. The question card is keyed on callId so the second
// shot re-uses the same card.
const seedQuestion = `layoutFixture.emitAgent({
  type: 'question',
  sessionId: 'a',
  request: {
    callId: 'q1',
    askedAt: Date.now(),
    questions: [{
      id: 'pull',
      header: 'Pull approach',
      question: 'How should I pull PR 1668 locally to try it?',
      options: [
        { label: 'gh pr checkout 1668', description: 'Uses the GitHub CLI; creates and switches to a local branch' },
        { label: 'git fetch and git switch', description: 'Fetch the remote branch, then switch to it' },
      ],
    }],
  },
})`;
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const minY = Math.min(...screen.getAllDisplays().map((d) => d.bounds.y));
  // Far off-screen in the "up-left" direction; show:false keeps it hidden.
  const win = new BrowserWindow({
    width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: minX - 4000, y: minY - 4000,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  // Double-capture pattern: the first capturePage forces a paint; the second
  // (after a short sleep) is the one we keep. Without this, the first shot in
  // a sequence can land on the previous frame.
  const shot = async (name) => {
    await win.capturePage(undefined, { stayHidden: true });
    await sleep(250);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    report.captures.push(file);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run('!!window.layoutFixture')); i++) await sleep(200);
    // showRetry mounts just the ChatPane for session 'a' (full-height), with a
    // short transcript that already includes an assistant reply. That assistant
    // reply is what canOfferSubagent wants.
    await run('layoutFixture.showRetry()');
    for (let i = 0; i < 60 && !(await run("!!document.querySelector('.composer-editor-wrap')")); i++) await sleep(200);
    await sleep(500);
    // Drop the interrupted message the showRetry fixture seeds; otherwise the
    // chat reads as paused and the composer is replaced with a Resume notice.
    await run(`(() => { const r = layoutFixture.records[0]; r.messages = r.messages.filter(m => !m.interrupted); layoutFixture.putCachedSession(r); })()`);
    await sleep(400);
    // Raise the agent's question. The 'question' event clears any errorNotice
    // and sets the QuestionCard, mirroring what the real engine emits.
    await run(seedQuestion);
    for (let i = 0; i < 60 && !(await run("!!document.querySelector('[data-agent-question]')")); i++) await sleep(200);
    await sleep(600);
    report.facts.questionVisibleEmpty = await run("!!document.querySelector('[data-agent-question]')");
    report.facts.chipsVisibleEmpty = await run("!!document.querySelector('[data-work-place]')");
    report.facts.chipsAfterQuestionEmpty = await run(`(() => {
      const q = document.querySelector('[data-agent-question]');
      const c = document.querySelector('[data-work-place]');
      if (!q || !c) return null;
      return !!(q.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
    })()`);
    report.facts.chipsBeforePrWatchEmpty = await run(`(() => {
      const c = document.querySelector('[data-work-place]');
      const w = document.querySelector('[data-pr-watch-continuation], [data-pr-watch]');
      if (!c || !w) return null;
      return !!(c.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING);
    })()`);
    report.facts.chipsTextEmpty = await run("document.querySelector('[data-work-place]')?.textContent ?? null");
    await shot('question-open__composer-empty');

    // Type a draft into the composer. Through document.execCommand('insertText')
    // the MarkdownEditor's input handler fires and the ChatPane's draft updates
    // the same way it would from real typing.
    await run(`(() => {
      const e = document.querySelector('.composer-editor-wrap [contenteditable]')
        || document.querySelector('.composer-editor-wrap textarea');
      if (!e) return false;
      e.focus();
      document.execCommand('insertText', false, 'Pull locally');
      return true;
    })()`);
    await sleep(700);
    report.facts.chipsVisibleDraft = await run("!!document.querySelector('[data-work-place]')");
    report.facts.chipsTextDraft = await run("document.querySelector('[data-work-place]')?.textContent ?? null");
    report.facts.draftValue = await run("document.querySelector('.composer-editor-wrap [contenteditable]')?.textContent ?? null");
    await shot('question-open__composer-draft');

    report.bounds = win.getBounds();
    report.hidden = !win.isVisible();
    report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation failed: window became visible or focused');
    report.success = true;
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    report.success = false;
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    try { win.destroy(); } catch {}
    app.exit(report.success && report.captures.length ? 0 : 1);
  }
});
