// Regression and matched evidence: no legacy placement row, even with a typed draft.
// Suggested actions keep their own slider; ordinary typed drafts use the composer.
// Run through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_SANDBOX=question-chips-sandbox.cjs. NEKKO_TEST_SOURCE captures the
// unchanged baseline without enforcing the new visibility expectations.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const report = { captures: [], checks: [], errors: [], baseline: !!process.env.NEKKO_TEST_SOURCE };
const seedQuestion = `layoutFixture.emitAgent({
  type: 'question', sessionId: 'a', request: {
    callId: 'q1', askedAt: Date.now(), questions: [{
      id: 'pull', header: 'Pull approach', question: 'How should I pull the PR locally to try it?',
      options: [
        { label: 'Use the GitHub CLI', description: 'Check out the pull request on a local branch' },
        { label: 'Use git fetch and git switch', description: 'Fetch the remote branch, then switch to it' },
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
  const win = new BrowserWindow({
    width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: minX - 4000, y: minY - 4000,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const check = (name, passed) => report.checks.push({ name, passed: !!passed });
  const shot = async (name) => {
    await win.capturePage(undefined, { stayHidden: true });
    await sleep(250);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    report.captures.push(file);
  };
  const typeDraft = async (text) => {
    await run(`(() => {
      const e = document.querySelector('.composer-editor-wrap [contenteditable]');
      if (!e) throw Error('Composer missing');
      e.focus(); document.execCommand('selectAll');
      document.execCommand('insertText', false, ${js(text)});
    })()`);
    await sleep(400);
  };
  try {
    for (const [label, width] of [['desktop', 1200], ['narrow', 390]]) {
      win.setContentSize(width, 900);
      await win.loadFile(path.join(out, 'index.html'));
      for (let i = 0; i < 60 && !(await run('!!window.layoutFixture')); i++) await sleep(200);
      await run('layoutFixture.showRetry()');
      for (let i = 0; i < 60 && !(await run("!!document.querySelector('.composer-editor-wrap')")); i++) await sleep(200);
      await run(`(() => {
        const r = layoutFixture.records[0];
        r.messages = r.messages.filter(m => !m.interrupted);
        layoutFixture.putCachedSession(r);
      })()`);
      await sleep(400);
      await run(seedQuestion);
      for (let i = 0; i < 60 && !(await run("!!document.querySelector('[data-agent-question]')")); i++) await sleep(200);
      await sleep(600);
      check(label + ': question visible with empty draft', await run("!!document.querySelector('[data-agent-question]')"));
      check(label + ': empty draft hides placement controls', await run("!document.querySelector('[data-work-place]')"));
      check(label + ': no automatic send', await run('!layoutFixture.lastSend'));
      await shot(label + '-question-empty');

      for (const [name, text] of [['whitespace', '   '], ['slash command', '/help'], ['typed answer', 'Pull locally']]) {
        await typeDraft(text);
        const visible = await run("!!document.querySelector('[data-work-place]')");
        check(label + ': ' + name + ' visibility', !visible);
      }
      await shot(label + '-question-draft');
      await typeDraft('');
      check(label + ': clearing draft hides controls again', await run("!document.querySelector('[data-work-place]')"));
      check(label + ': editing has not sent anything', await run('!layoutFixture.lastSend'));
      await typeDraft('Pull locally');
      await run("document.querySelector('[data-composer-action=send]').click()");
      await sleep(500);
      check(label + ': direct action sends exact draft', await run("layoutFixture.lastSend?.text === 'Pull locally'"));
      check(label + ': direct send hides empty row', await run("!document.querySelector('[data-work-place]')"));
    }
    report.bounds = win.getBounds();
    report.hidden = !win.isVisible();
    report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation failed: window became visible or focused');
    report.success = !report.errors.length && (report.baseline || report.checks.every(c => c.passed));
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
