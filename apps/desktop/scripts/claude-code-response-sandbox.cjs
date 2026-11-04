// Synthetic evidence for the "Claude Code's response" mark; never connects to the user's host or profile.
// Run: NEKKO_FIXTURE=claude-code-response-fixture.tsx NEKKO_SANDBOX=claude-code-response-sandbox.cjs node chat-search-integration.cjs
// (NEKKO_TEST_REVISION=<rev> for "before"). Hidden, non-focusable, off-screen; no input at all.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-search-integration.cjs');
const before = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, before ? 'before' : 'after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 730, height: 520, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic Claude Code response verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [] };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message.slice(0, 300)); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('document.querySelectorAll("[data-done-row]").length >= 2')); i++) await sleep(200);
    await sleep(500);
    const marks = await run('[...document.querySelectorAll("[data-claude-code-response]")].map(m => ({ text: m.textContent, row: m.closest("[data-done-row]")?.textContent || "" }))');
    if (!before) {
      check('exactly one mark, on the Claude Code reply', marks.length === 1 && /path\.join/.test(await run('document.querySelector("[data-claude-code-response]").closest(".msg-ai").textContent')));
      check("it reads Claude Code's response, beside Done", marks[0] && marks[0].text === "Claude Code's response" && /Done\./.test(marks[0].row));
    } else check('no mark before the change', marks.length === 0);
    fs.writeFileSync(path.join(dir, 'claude-code-response.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.quit();
});
