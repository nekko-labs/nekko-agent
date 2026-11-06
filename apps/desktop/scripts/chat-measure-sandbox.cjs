// Synthetic reply-column evidence; never connects to the user's host or profile.
// Launch through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_FIXTURE=chat-measure-fixture.tsx NEKKO_LAYOUT_SANDBOX=chat-measure-sandbox.cjs.
// Captures one reply (prose, a wide table, a code block) at a wide and a narrow
// window and measures where each block's right edge falls, so "the prose stops
// halfway while the table runs on" is a number, not an impression.
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
  const reply = [...s.querySelectorAll('.msg-ai')].pop();
  const box = el => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; };
  const ps = [...reply.querySelectorAll('p')];
  const table = reply.querySelector('table');
  const pre = reply.querySelector('pre');
  const col = s.firstElementChild;
  return { pane: box(s), column: box(col), user: box(s.querySelector('.msg-user')), paragraphRight: Math.max(...ps.map(p => box(p).right)), table: table && box(table.parentElement.closest('.overflow-x-auto') || table), code: pre && box(pre) };
})()`;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 1500, height: 860, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic reply column verification',
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
    for (const [width, theme] of [[1500, 'dark'], [1500, 'light'], [700, 'dark']]) {
      win.setContentSize(width, 860);
      await run(`document.documentElement.dataset.theme='${theme}'`);
      await run('integration.reset()'); await sleep(1500);
      await run("document.querySelector('[data-transcript-scroll]').scrollTop = 0"); await sleep(300);
      report.measures[`${width}-${theme}`] = await run(measure);
      await capture(`reply-${width}-${theme}`);
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
