// Hidden synthetic desktop evidence. No user profile, host, model or network.
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
  try {
    for (const width of [1280, 640]) {
      if (win) win.destroy();
      win = new BrowserWindow({ width, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) - 3000, y: -2000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
      win.on('focus', () => report.errors.push('Fixture took focus'));
      await win.loadFile(path.join(out, 'index.html'));
      await sleep(1600);
      await run(`layoutFixture.store.getState().setView('settings')`);
      await sleep(1000);
      await run(`[...document.querySelectorAll('h2')].find(h => h.textContent === 'Agent loop')?.scrollIntoView({block:'start'})`);
      await capture(`settings-off-${width}`);
      const present = await run(`!!document.querySelector('[aria-label="Automatically resume after internet restoration"]')`);
      check(`settings rendered (${width})`, await run(`document.body.textContent.includes('Agent loop')`));
      if (present) {
        check(`default off (${width})`, await run(`document.querySelector('[aria-label="Automatically resume after internet restoration"]').getAttribute('aria-checked') === 'false'`));
        await run(`document.querySelector('[aria-label="Automatically resume after internet restoration"]').click()`);
        await sleep(250);
        check(`opt-in persisted (${width})`, await run(`layoutFixture.store.getState().settings.autoResumeOnInternetRestore === true`));
        await capture(`settings-on-${width}`);
        await run(`document.querySelector('[aria-label="Automatically resume after internet restoration"]').click()`);
      }
      await run(`(() => {
        const f = layoutFixture, s = f.records[0];
        s.messages = [{id:'u1',role:'user',content:'Continue the synthetic documentation task.',createdAt:1781690400000}, {id:'a1',role:'assistant',content:'The completed tool results are saved. The reply was interrupted.',interrupted:true,createdAt:1781690410000}];
        s.connectivityNotices = [{id:'n1',kind:'lost',createdAt:1781690420000,content:'Internet reachability lost on this computer. Saved work is retained.'}, {id:'n2',kind:'restored',createdAt:1781690460000,content:'Internet reachability restored on this computer. This reply remains interrupted; select Continue to resume.'}];
        f.putCachedSession(s); f.store.getState().setView('chat'); f.store.getState().openChatPane(s.id);
      })()`);
      await sleep(1500);
      await run(`document.querySelector('[aria-label="Internet connectivity notices"]')?.scrollIntoView({block:'center'})`);
      await capture(`chat-notices-${width}`);
      check(`no horizontal overflow (${width})`, await run(`document.documentElement.scrollWidth <= innerWidth`));
      if (present) {
        check(`timestamped notices (${width})`, await run(`document.querySelectorAll('[aria-label="Internet connectivity notices"] time').length >= 2`));
        check(`notices do not start a run (${width})`, await run(`!document.querySelector('button[aria-label="Stop"]')`));
      }
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0);
});
