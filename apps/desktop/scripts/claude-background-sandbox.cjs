// Hidden synthetic desktop evidence for a Claude Agent chat whose Claude Code
// still runs background tasks after the turn's Done (#1408). No user profile,
// host, model or network.
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
  let win;
  const check = (name, passed) => report.checks.push({ name, passed: !!passed });
  const run = js => win.webContents.executeJavaScript(js, true);
  const capture = async name => {
    await sleep(500);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  };
  const line = `document.querySelector('[data-claude-background]')`;
  try {
    for (const width of [1280, 640]) {
      if (win) win.destroy();
      win = new BrowserWindow({ width, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) - 3000, y: -2000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
      win.on('focus', () => report.errors.push('Fixture took focus'));
      await win.loadFile(path.join(out, 'index.html'));
      await sleep(1600);
      await run(`(() => {
        const f = layoutFixture, s = f.records[0];
        s.messages = [{id:'u1',role:'user',content:'Find where the wake-up turn returns early.',createdAt:1781690400000}, {id:'a1',role:'assistant',content:'Explore agent is scanning the daemon. I will wait for its report.',createdAt:1781690410000}];
        f.putCachedSession(s); f.store.getState().setView('chat'); f.store.getState().openChatPane(s.id);
        window.__claudeBackgroundSession = s.id;
      })()`);
      await sleep(1500);
      // The first-visit zones intro would cover the chat.
      await run(`document.querySelector('.zones-intro button[aria-label="Close"]')?.click()`);
      await sleep(2000);
      await run(`layoutFixture.emitAgent({ type: 'claude_code_background', sessionId: window.__claudeBackgroundSession, tasks: 1 })`);
      await sleep(300);
      await run(`(${line} || document.querySelector('[data-message-id="a1"]') || document.body).scrollIntoView({block:'center'})`);
      await capture(`chat-background-${width}`);
      check(`says one task runs (${width})`, await run(`${line}?.textContent.includes('still running 1 background task.')`));
      check(`does not start a run (${width})`, await run(`!document.querySelector('button[aria-label="Stop"]')`));
      check(`no horizontal overflow (${width})`, await run(`document.documentElement.scrollWidth <= innerWidth`));
      await run(`layoutFixture.emitAgent({ type: 'claude_code_background', sessionId: window.__claudeBackgroundSession, tasks: 0 })`);
      await sleep(300);
      check(`gone once none run (${width})`, await run(`!${line}`));
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0);
});
