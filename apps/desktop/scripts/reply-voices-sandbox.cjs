// Synthetic evidence for how a working turn reads; never connects to the user's
// host or profile. Launch through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_FIXTURE=reply-voices-fixture.tsx NEKKO_LAYOUT_SANDBOX=reply-voices-sandbox.cjs.
// Captures one turn at a wide and a narrow window and records where each block's
// text column starts and ends: thinking, notes and replies must share one
// column, so a note becoming a reply does not re-wrap its text.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const measure = `(() => {
  const s = document.querySelector('[data-transcript-scroll]');
  const box = el => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; };
  const voice = el => el.dataset.voice || (el.closest('[data-chat-thought]') ? 'thought' : 'plain');
  return {
    pane: box(s),
    blocks: [...s.querySelectorAll('.msg-ai p')].map(p => ({ voice: voice(p.closest('.msg-ai')), text: box(p), start: p.textContent.slice(0, 32) })),
    topics: [...s.querySelectorAll('[data-topic]')].map(t => t.dataset.topic + ': ' + t.textContent),
    surfaces: [...s.querySelectorAll('.msg-ai[data-voice]')].map(el => {
      const css = getComputedStyle(el);
      return { voice: voice(el), background: css.backgroundColor, radius: css.borderRadius,
        borders: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth],
        leftColor: css.borderLeftColor, box: box(el) };
    }),
  };
})()`;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 1500, height: 1500, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic reply voices verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { errors: [], measures: {} };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const capture = async name => { await sleep(300); fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1500);
    for (const [width, theme] of [[1500, 'dark'], [1500, 'light'], [700, 'dark'], [390, 'dark']]) {
      win.setContentSize(width, width === 390 ? 2300 : 1500);
      await run(`document.documentElement.dataset.theme='${theme}'`);
      await run('integration.reset()'); await sleep(1500);
      await run("document.querySelector('[data-transcript-scroll]').scrollTop = 0"); await sleep(300);
      report.measures[`${width}-${theme}`] = await run(measure);
      await capture(`voices-${width}-${theme}`);
    }
    report.success = !report.errors.some(e => /focus/.test(e));
  } catch (error) {
    report.errors.push(String(error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, success: report.success, errors: [...new Set(report.errors)].slice(0, 6), measures: report.measures }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
