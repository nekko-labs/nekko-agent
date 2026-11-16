// Evidence for #2880: expanding a group until the Agents panel scrolls must not narrow its cards.
// Run through wall-polish-integration.cjs (NEKKO_SANDBOX=agent-panel-gutter-sandbox.cjs) in a hidden,
// non-focusable Electron window, with synthetic chats only. NEKKO_GUTTER_LABEL=before names a capture
// taken with commandWallLayouts.css checked out from the base commit.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Run through wall-polish-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const label = process.env.NEKKO_GUTTER_LABEL || 'after';
const report = { label, steps: [], captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 700, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = js => win.webContents.executeJavaScript(js, true);
  const measure = `(() => { const list = document.querySelector('[data-agent-panel-list]'); const card = [...list.querySelectorAll('[data-group-cards]:not([data-collapsed]) > *')].find(e => e.getBoundingClientRect().width > 0); return { scrolls: list.scrollHeight > list.clientHeight, clientWidth: list.clientWidth, cardWidth: card ? Math.round(card.getBoundingClientRect().width) : null }; })()`;
  const groups = `[...document.querySelectorAll('[data-agent-panel-list] [data-agent-group]')]`;
  const shot = async name => { const file = path.join(out, `gutter-${label}-${name}.png`); fs.writeFileSync(file, (await win.capturePage({ x: 0, y: 0, width: 400, height: 700 }, { stayHidden: true })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('!!window.integration')); i++) await sleep(100);
    await run(`integration.reset({ many: true }); localStorage.setItem('nekko.agentPanelView', JSON.stringify({ groupBy: 'project' }))`);
    await sleep(900);
    // Collapse every group, then open them one at a time until the list has to scroll.
    await run(`${groups}.forEach(g => { if (!g.querySelector('[data-group-cards]')?.hasAttribute('data-collapsed')) g.querySelector('[data-sidebar-group]').click(); })`);
    await sleep(300);
    const count = await run(`${groups}.length`);
    for (let i = 0; i < count; i++) {
      const before = await run(measure);
      await run(`${groups}[${i}].querySelector('[data-sidebar-group]').click()`);
      await sleep(300);
      const after = await run(measure);
      report.steps.push({ expanded: i, after });
      if (!before.scrolls && after.scrolls && before.cardWidth) {
        // Re-collapse for the matched "not scrolling" frame, then expand again.
        await run(`${groups}[${i}].querySelector('[data-sidebar-group]').click()`); await sleep(300);
        report.fits = await run(measure); await shot('fits');
        await run(`${groups}[${i}].querySelector('[data-sidebar-group]').click()`); await run(`document.querySelector('[data-agent-panel-list]').scrollTop = 0`); await sleep(300);
        report.scrolls = await run(measure); await shot('scrolls');
        break;
      }
    }
    if (!report.fits) throw Error('Fixture never went from fitting to scrolling with a card laid out');
    report.cardWidthChange = report.scrolls.cardWidth - report.fits.cardWidth;
    report.hidden = !win.isVisible();
    if (process.env.NEKKO_ASSERT_GUTTER === '1' && report.cardWidthChange !== 0) throw Error(`Cards changed width by ${report.cardWidthChange}px when the list started to scroll`);
  } catch (error) { report.errors.push(String(error?.stack || error)); }
  fs.writeFileSync(path.join(out, `gutter-${label}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ label, fits: report.fits, scrolls: report.scrolls, cardWidthChange: report.cardWidthChange, hidden: report.hidden, errors: report.errors }, null, 2));
  app.exit(report.hidden && !report.errors.length && report.captures.length ? 0 : 1);
});
