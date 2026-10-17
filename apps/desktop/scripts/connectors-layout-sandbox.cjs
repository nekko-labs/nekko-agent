const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_COMPONENT_OUT;
const work = process.env.NEKKO_COMPONENT_WORK;
if (!out || !work) throw Error('Use connectors-layout-integration.cjs');
const base = Boolean(process.env.NEKKO_TEST_REVISION);
const tag = base ? 'before' : 'after';
const dir = path.join(out, tag);
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(work, 'profile'));
app.setPath('sessionData', path.join(work, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1600, height: 1000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [], layout: {} };
  const run = code => win.webContents.executeJavaScript(code, true);
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  // Distinct card left edges (= columns) and how many cards there are.
  const cols = `(() => { const cards = [...document.querySelectorAll('.card')].filter(c => !c.parentElement.closest('.card'));
    return { cards: cards.length, columns: new Set(cards.map(c => Math.round(c.getBoundingClientRect().left))).size }; })()`;
  try {
    await win.loadFile(path.join(work, 'index.html')); await sleep(500);
    for (const theme of ['dark', 'light']) for (const [width, size, want] of [[1600, 'wide', 3], [1000, 'medium', 2], [600, 'narrow', 1]]) {
      // Tall enough to show every card in one capture.
      win.setContentSize(width, size === 'narrow' ? 5200 : size === 'medium' ? 2800 : 2000);
      await run(`window.__fixture.show('${theme}')`); await sleep(500);
      const layout = await run(cols);
      report.layout[`${theme}-${size}`] = layout;
      if (!base) {
        if (layout.columns !== want) report.errors.push(`${theme}/${size}: expected ${want} columns, saw ${JSON.stringify(layout)}`);
        else report.checks.push(`${theme}/${size} lays out ${want} column(s)`);
      }
      const file = path.join(dir, `connectors-${theme}-${size}.png`);
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      report.captures.push(file);
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused() };
  } catch (e) { report.errors.push(String(e)); }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks, errors: report.errors, layout: report.layout, background: report.background }, null, 1)); win.destroy(); app.exit(report.errors.length ? 1 : 0); }
});
