// Synthetic reply evidence. No host, network, user profile or OS input.
// NEKKO_TEST_REVISION=<rev> captures matching before evidence.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-search-integration.cjs');
const before = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, before ? 'before' : 'after');
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
    x: left - 3000, y: -2000, title: 'Synthetic Claude Code speaker verification',
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
    for (const [label, width, height] of [['desktop', 730, 520], ['narrow', 390, 720]]) {
      win.setContentSize(width, height);
      await sleep(500);
      const layout = await run(`(() => {
        const marks = [...document.querySelectorAll('[data-claude-code-response]')];
        const mark = marks[0];
        const reply = mark?.closest('.msg-ai');
        const body = reply?.querySelector('[data-chat-search-text]');
        const h = mark?.getBoundingClientRect(), b = body?.getBoundingClientRect();
        return {
          count: marks.length, text: mark?.textContent, claudeReply: /path\\.join/.test(reply?.textContent || ''),
          footer: !!mark?.closest('[data-done-row]'),
          above: h && b && h.bottom <= b.top, left: h && b && Math.abs(h.left - b.left) < 1,
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
        };
      })()`);
      check(label + ': exactly one identity on the Claude Code reply', layout.count === 1 && layout.claudeReply);
      check(label + ': no horizontal overflow', layout.noOverflow);
      if (!before) {
        check(label + ': speaker name and initials avatar', layout.text === 'CCClaude Code');
        check(label + ': top-left above text, not in the footer', layout.above && layout.left && !layout.footer);
      }
      fs.writeFileSync(path.join(dir, 'claude-code-speaker-' + label + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    }
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length || report.checks.some(c => !c.passed)) process.exitCode = 1;
  win.destroy();
  app.quit();
});
