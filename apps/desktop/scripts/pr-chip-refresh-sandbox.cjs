// Captures pr-chip-refresh-fixture.tsx in a hidden, off-screen, non-focusable
// window: the reply's PR chips and the agent card's chip while the PRs are open,
// then again after the stub GitHub merges them and the window "regains focus"
// (a synthetic event; the native window never takes focus). Launch through
// layout-evidence-integration.cjs with NEKKO_LAYOUT_FIXTURE=pr-chip-refresh-fixture.tsx.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [], metrics: {} };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Nekko PR chip refresh, isolated verification', width: 1180, height: 420, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 500)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => {
    // The hidden compositor can hand back the previous frame first.
    await win.capturePage(undefined, { stayHidden: true });
    await sleep(200);
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    const f = path.join(out, name + '.png');
    fs.writeFileSync(f, image.toPNG());
    report.captures.push(f);
  };
  const states = () => run(`(() => ({
    reply: [...document.querySelectorAll('.pr-link-chip')].map(e => e.dataset.prStatus),
    card: [...document.querySelectorAll('[data-session-pr-chip]')].map(e => e.dataset.prStatus),
    reads: { ...prRefreshFixture.reads },
  }))()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !await run(`!!window.prRefreshFixture && document.querySelectorAll('.pr-link-chip[data-pr-status="open"]').length === 2 && !!document.querySelector('[data-session-pr-chip]')`); i++) await sleep(100);
    await sleep(600);
    report.metrics.open = await states();
    await shot('open');
    await run('prRefreshFixture.merge()');
    // Past half the 60s freshness window, so a focus re-check may read again.
    await sleep(31_000);
    await run(`window.dispatchEvent(new Event('focus'))`);
    await sleep(1500);
    report.metrics.afterFocus = await states();
    await shot('after-merge-focus');
    if (!process.env.NEKKO_TEST_LABEL?.startsWith('before')) {
      const m = report.metrics.afterFocus;
      if (m.reply.join() !== 'merged,merged') throw Error('Reply chips did not refresh: ' + m.reply.join());
      if (!m.card.every(s => s === 'merged') || m.card.length === 0) throw Error('Agent card chip did not refresh: ' + m.card.join());
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
