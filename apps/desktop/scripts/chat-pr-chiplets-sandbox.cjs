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
  const win = new BrowserWindow({ title: 'Nekko chat chiplets — isolated verification', width: 1440, height: 1100, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 500)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !await run('!!window.chipletFixture && !!document.querySelector(".agent-chip")'); i++) await sleep(100);
    await sleep(1200);
    const metrics = () => run(`(() => { const rows = [...document.querySelectorAll('.agent-chip')]; const row = title => rows.find(e => e.title === title); return { calls: chipletFixture.calls, chips: document.querySelectorAll('[data-session-pr-chip]').length, doneContext: [...(row('Ship sidebar improvements')?.querySelectorAll('[title]') || [])].some(e => e.title.startsWith('Context window:')), workingContext: [...(row('Implement next feature')?.querySelectorAll('[title]') || [])].some(e => e.title.startsWith('Context window:')), watchingContext: [...(row('Watch required CI checks')?.querySelectorAll('[title]') || [])].some(e => e.title.startsWith('Context window:')), count: document.querySelector('[aria-label="3 pull requests from this chat"]')?.textContent, viewport: innerWidth }; })()`);
    report.metrics.darkWide = await metrics();
    await shot('dark-wide');
    await run(`document.querySelector('[aria-label="3 pull requests from this chat"]')?.click()`);
    await sleep(200);
    report.metrics.menuLinks = await run(`[...document.querySelectorAll('[role="menuitem"]')].map(e => e.getAttribute('href'))`);
    await shot('multiple-prs');
    await run(`document.querySelector('[role="menuitem"]')?.click()`);
    report.metrics.link = await run('({ opened: chipletFixture.opened, selected: chipletFixture.selected })');
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(100);
    // Clicked/pinned lists dismiss on Escape. Blur/pointer grace can take 150ms.
    await run(`document.activeElement?.blur(); document.querySelector('[aria-label="3 pull requests from this chat"]')?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))`);
    await sleep(200);
    report.metrics.dismissed = await run(`!document.querySelector('[role="menu"]')`);
    await run(`document.documentElement.dataset.theme = 'light'`);
    await sleep(200); await shot('light-wide');
    win.setContentSize(420, 1100);
    await run(`document.querySelector('[aria-label="Open agent list"]')?.click()`);
    await sleep(250); await shot('light-narrow');
    await run(`document.documentElement.dataset.theme = 'dark'`);
    await sleep(200); await shot('dark-narrow');
    report.metrics.narrow = await metrics();
    report.metrics.painted = await run(`(() => { const r = document.querySelector('.agent-chip').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
    report.metrics.overflow = await run('document.documentElement.scrollWidth > innerWidth');
    if (report.metrics.painted.width <= 0 || report.metrics.painted.height <= 0) throw Error('Sidebar is not laid out for capture');
    if (process.env.NEKKO_TEST_LABEL !== 'before') {
      const m = report.metrics;
      if (new Set(m.darkWide.calls).size !== 12 || m.darkWide.chips !== 12) throw Error('All 12 visible Done chats must hydrate');
      if (m.darkWide.doneContext || !m.darkWide.workingContext || !m.darkWide.watchingContext) throw Error('Context lifecycle visibility mismatch');
      if (m.darkWide.count?.trim() !== '+2' || m.menuLinks.length !== 3) throw Error('Multiple PR count/list missing');
      if (m.link.opened.length !== 1 || m.link.selected.length !== 0 || !m.dismissed) throw Error('PR link/dismissal event isolation failed');
      if (m.overflow) throw Error('Narrow sidebar overflows');
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
