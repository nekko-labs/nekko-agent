// Matched scroll evidence for the vertical Agents panel, with synthetic chats only.
// Run through wall-polish-integration.cjs in a hidden, non-focusable Electron window.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Run through wall-polish-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 500, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = js => win.webContents.executeJavaScript(js, true);
  const measure = `(() => { const list = document.querySelector('[data-agent-panel-list]'); const groups = [...list.querySelectorAll('[data-agent-group]')]; const box = e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; }; return { scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, list: box(list), groups: groups.map(g => ({ key: g.getAttribute('data-agent-group'), group: box(g), heading: g.querySelector('.agent-panel-group-heading') ? box(g.querySelector('.agent-panel-group-heading')) : null })) }; })()`;
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage({ x: 0, y: 0, width: 400, height: 500 }, { stayHidden: true })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('!!window.integration')); i++) await sleep(100);
    // reset clears localStorage and schedules a remount. Set the view before it commits.
    await run(`integration.reset({ many: true }); localStorage.setItem('nekko.agentPanelView', JSON.stringify({ groupBy: 'project' }))`);
    await sleep(900);
    report.start = await run(measure);
    const list = () => "document.querySelector('[data-agent-panel-list]')";
    const first = report.start.groups.find(g => g.heading && g.group.height > 180);
    if (!first || report.start.scrollHeight <= report.start.list.height + 300) throw Error('Fixture lacks scrollable groups');
    // Scroll inside the first long group, then until the next group takes over.
    const offset = Math.min(180, Math.max(50, first.group.height / 3));
    await run(`${list()}.scrollTop = ${offset}`); await sleep(200);
    report.within = await run(measure); await shot('within-group');
    const next = report.start.groups.find(g => g.heading && g.group.top > first.group.bottom - 2);
    if (next) {
      await run(`${list()}.scrollTop = ${Math.max(offset, next.group.top - report.start.list.top + 45)}`); await sleep(200);
      report.handoff = await run(measure); await shot('next-group');
    }
    // A short frame sequence is scroll-motion evidence, not an animation claim.
    await run(`${list()}.scrollTop = 0`); await sleep(100);
    for (let i = 0; i < 8; i++) { await run(`${list()}.scrollTop = ${Math.round(offset * (i + 1) / 8)}`); await sleep(80); await shot(`frame-${i}`); }
    await run(`document.querySelector('[data-agent-group="ws-a"] [data-sidebar-group]').click()`);
    await sleep(250);
    report.collapsed = await run(`document.querySelector('[data-agent-group="ws-a"] [data-group-cards]').hasAttribute('data-collapsed')`);
    await run(`integration.reset({ many: true, horizontal: true }); localStorage.setItem('nekko.agentPanelView', JSON.stringify({ groupBy: 'project' }))`);
    await sleep(500);
    report.horizontal = await run(`(() => { const list = document.querySelector('[data-agent-panel-list]'); return { position: getComputedStyle(list.querySelector('.agent-panel-group-heading')).position, scrollable: list.scrollWidth > list.clientWidth }; })()`);
    report.hidden = !win.isVisible();
    if (process.env.NEKKO_ASSERT_STICKY === '1') {
      if (!report.collapsed || report.horizontal.position === 'sticky' || !report.horizontal.scrollable) throw Error('Collapse or horizontal row behavior regressed');
      const heading = report.within.groups.find(g => g.key === first.key).heading;
      if (Math.abs(heading.top - report.within.list.top) > 3) throw Error(`Group header did not stick: ${heading.top} vs ${report.within.list.top}`);
      if (report.handoff) {
        const incoming = report.handoff.groups.find(g => g.key === next.key).heading;
        const outgoing = report.handoff.groups.find(g => g.key === first.key).heading;
        if (Math.abs(incoming.top - report.handoff.list.top) > 3 || outgoing.bottom > incoming.top + 3) throw Error('Headings did not hand off at the group boundary');
      }
    }
  } catch (error) { report.errors.push(String(error?.stack || error)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.hidden && !report.errors.length && report.captures.length ? 0 : 1);
});
