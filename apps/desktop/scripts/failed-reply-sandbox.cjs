// Synthetic failed-reply checks: a chat reopened after its last turn failed.
// Launch with NEKKO_FIXTURE=failed-reply-fixture.tsx NEKKO_SANDBOX=failed-reply-sandbox.cjs
// node apps/desktop/scripts/chat-search-integration.cjs
// Off-screen, non-focusable, its own profile, network blocked.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-search-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const notice = "document.querySelector('[role=alert]')";
const button = (label) => `[...document.querySelectorAll('[role=alert] button')].find((b) => b.textContent.trim() === '${label}')`;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const bounds = screen.getAllDisplays().map((display) => display.bounds);
  const win = new BrowserWindow({
    width: 1100, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: Math.min(...bounds.map((b) => b.x)) - 1600, y: Math.min(...bounds.map((b) => b.y)) - 1600,
    title: 'Synthetic failed reply verification',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const report = { checks: [], failed: [], errors: [] };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', (details) => { if (details.level === 'error') report.errors.push(details.message); });
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => { (await run(source) ? report.checks : report.failed).push(name); };
  const capture = async (name) => {
    await sleep(250);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1500);

    await check('the notice is back with the original error', `${notice}?.textContent.includes('Reply failed') && ${notice}.textContent.includes("You've hit your usage limit.")`);
    await check('it offers Retry', `!!${button('Retry')}`);
    await check('it offers Delete last message', `!!${button('Delete last message')}`);
    await capture('reopened');

    await run(`${notice}.querySelector('button[title=Dismiss]').click()`);
    await sleep(400);
    await check('Dismiss hides the notice', `!${notice}`);
    await check('Dismiss clears the saved failure', "integration.calls().length === 1 && integration.calls()[0].patch.turnFailure === null");
    await run('integration.reopen()');
    await sleep(800);
    await check('a dismissed failure stays gone after reopening', `!${notice}`);

    await run('integration.movedOn()');
    await sleep(800);
    await check('a failure the transcript has moved past shows nothing', `!${notice}`);
    await capture('moved-on');

    await run('integration.stopped()');
    await sleep(800);
    await check('a saved Stop reads as paused and offers Retry', `${notice}?.textContent.includes('Reply paused') && !!${button('Retry')}`);
    await capture('stopped');

    await run('integration.cutOff()');
    await sleep(800);
    await check('a transcript ending on a tool result offers Retry with no record', `${notice}?.textContent.includes('Reply interrupted') && !!${button('Retry')}`);
    await capture('cut-off');
    await run(`${notice}.querySelector('button[title=Dismiss]').click()`);
    await sleep(400);
    await check('Dismiss hides the inferred notice', `!${notice}`);
    await run('integration.reopen()');
    await sleep(800);
    await check('a dismissed inferred notice stays gone after reopening', `!${notice}`);

    await run('integration.running()');
    await sleep(800);
    await check('a run still going is not called interrupted', `!${notice}`);
  } catch (e) {
    report.errors.push(String(e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.failed.length || report.errors.length ? 1 : 0);
});
