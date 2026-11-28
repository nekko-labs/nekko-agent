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
  const report = { checks: [], errors: [], windows: [] };
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  if (process.platform === 'darwin') app.dock.hide();
  for (const [label, width, height] of [['desktop', 730, 520], ['narrow', 390, 720]]) {
    const win = new BrowserWindow({
      width, height, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
      x: left - 3000, y: -2000, title: 'Synthetic reply provenance verification',
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true },
    });
    win.on('focus', () => report.errors.push('Fixture took focus'));
    win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message.slice(0, 300)); });
    const run = source => win.webContents.executeJavaScript(source, true);
    try {
      await win.loadFile(path.join(out, 'index.html'));
      for (let i = 0; i < 50 && !(await run('document.querySelectorAll("[data-done-row]").length >= 2')); i++) await sleep(200);
      await run('document.fonts.ready.then(() => true)');
      const bounds = win.getBounds();
      report.windows.push({ label, bounds, visible: win.isVisible(), focused: win.isFocused() });
      check(label + ': window kept hidden and unfocused', !win.isVisible() && !win.isFocused());
      const layout = await run(`(() => {
        const replies = [...document.querySelectorAll('.msg-ai')];
        return {
          marks: [...document.querySelectorAll('[data-claude-code-response]')].map(el => el.textContent),
          first: replies.map(el => el.firstElementChild?.hasAttribute('data-chat-search-text')),
          provenance: replies.map(el => el.querySelector('[data-turn-stats]')?.title.split('\\n')[0]),
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
        };
      })()`);
      check(label + ': no horizontal overflow', layout.noOverflow);
      check(label + ': both turns retain their own model and provider', JSON.stringify(layout.provenance) === JSON.stringify(['Model: opus (cc)', 'Model: qwen3-8b (local)']));
      check(label + ': expected first elements', layout.first.length === 2 && layout.first[0] === !before && layout.first[1]);
      check(label + ': only baseline has a speaker badge', JSON.stringify(layout.marks) === JSON.stringify(before ? ['CCClaude Code'] : []));
      fs.writeFileSync(path.join(dir, 'reply-' + (before ? 'before-' : 'after-') + label + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    } catch (e) {
      report.errors.push(String(e && e.stack || e));
    } finally {
      win.destroy();
      await sleep(250);

    }
  }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const failed = report.errors.length || report.checks.some(c => !c.passed);
  app.exit(failed ? 1 : 0);
});
