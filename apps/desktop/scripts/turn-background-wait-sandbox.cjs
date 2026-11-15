// Hidden synthetic desktop evidence for a Claude Agent turn that Claude Code
// holds open, saying nothing, while its background tasks run: the status line
// names the tasks instead of a model wait. No user profile, host, model or network.
// NEKKO_EXPECT_BACKGROUND_WAIT=1 enforces the new wording (unset for a "before" run).
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const report = { checks: [], errors: [] };
  const check = (name, passed) => report.checks.push({ name, passed: !!passed });
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) - 3000, y: -2000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  const run = js => win.webContents.executeJavaScript(js, true);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1600);
    await run(`(() => {
      const f = layoutFixture, s = f.records[0];
      s.messages = [{id:'u1',role:'user',content:'Land the fix and keep an eye on the simulator runs.',createdAt:1781690400000}];
      f.putCachedSession(s); f.store.getState().setView('chat'); f.store.getState().openChatPane(s.id);
      window.__waitSession = s.id;
    })()`);
    await sleep(1500);
    // The first-visit zones intro would cover the chat.
    await run(`document.querySelector('.zones-intro button[aria-label="Close"]')?.click()`);
    await sleep(1500);
    await run(`(() => {
      const f = layoutFixture, sessionId = window.__waitSession;
      f.emitAgent({ type: 'claude_code_background', sessionId, tasks: 2 });
      f.emitAgent({ type: 'text', sessionId, delta: 'The fix is merged. Only the simulator runs are still going.' });
      f.emitAgent({ type: 'usage', sessionId, inputTokens: 1200, outputTokens: 18, outputMs: 900 });
    })()`);
    await sleep(700);
    await run(`document.querySelector('[data-turn-activity]')?.scrollIntoView({block:'center'})`);
    await sleep(600);
    // A hidden window can leave the pane's entrance animation unfinished, which paints the transcript blank.
    await run(`document.getAnimations().forEach(a => { try { a.finish(); } catch {} })`);
    await sleep(400);
    const status = await run(`document.querySelector('[data-turn-activity]')?.textContent || ''`);
    report.status = status;
    fs.writeFileSync(path.join(out, 'background-wait.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    check('the turn status line is shown', status.includes('Turn elapsed'));
    if (process.env.NEKKO_EXPECT_BACKGROUND_WAIT === '1') check('names the background tasks', status.includes('Waiting on 2 background tasks'));
    const reply = await run(`document.querySelector('[data-turn-activity]')?.parentElement?.parentElement?.textContent || ''`);
    if (process.env.NEKKO_EXPECT_BACKGROUND_WAIT === '1') check('the reply line agrees', reply.includes('Waiting on background tasks') && !reply.includes('Writing reply'));
    check('no horizontal overflow', await run(`document.documentElement.scrollWidth <= innerWidth`));
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0);
});
