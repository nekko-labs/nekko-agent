// Isolated, hidden real-renderer evidence. Run through layout-evidence-integration.cjs
// with NEKKO_LAYOUT_FIXTURE=agent-group-limit-fixture.tsx and this sandbox.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: [], captures: [], errors: [] };
const limited = process.env.NEKKO_EXPECT_LIMIT === '1';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 1100, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') console.error(e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const shot = async name => { await sleep(400); const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const counts = () => run(`Object.fromEntries([...document.querySelectorAll('[data-agent-group]')].map(g => [g.dataset.agentGroup, g.querySelectorAll('[data-agent-card]').length]))`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run("!!document.querySelector('[data-agent-group=alpha]')")); i++) await sleep(200);
    await sleep(400);
    report.initial = await counts();
    assert.deepEqual(report.initial, { alpha: limited ? 20 : 65, beta: limited ? 20 : 65 });
    report.initialPrReads = await run('groupLimitFixture.prReads');
    assert.equal(report.initialPrReads.length, limited ? 0 : 2);
    await shot('groups-desktop');
    if (limited) {
      await run("document.querySelector('[data-agent-group=alpha] [data-agent-more]').click()");
      await sleep(200);
      assert.deepEqual(await counts(), { alpha: 65, beta: 20 });
      assert.equal(await run("!!document.querySelector('[data-agent-group=alpha] [data-agent-more]')"), false);
      assert.deepEqual(await run('groupLimitFixture.prReads'), ['alpha-64']);
      report.checks.push('One click expands all 65 Alpha rows without expanding Beta; only then fetches hidden PR details');
      await run("groupLimitFixture.select('beta-64')"); await sleep(300);
      assert.deepEqual(await counts(), { alpha: 65, beta: 20 });
      assert.equal(await run("document.querySelector('[data-agent-group=beta] .agent-chip-chat[data-agent-active]')?.title"), 'Beta task 65');
      report.checks.push('Selecting the last hidden agent keeps the 20-row cap and reveals selection');
      await run("groupLimitFixture.select(null)");
    }
    await run("document.querySelector('[data-agent-group=alpha] [data-completed-toggle]').click()");
    await sleep(300);
    report.completedInitial = await run("document.querySelectorAll('[data-agent-group=alpha] [data-completed-row]').length");
    assert.equal(report.completedInitial, limited ? 20 : 50);
    if (limited) {
      await run("document.querySelector('[data-agent-group=alpha] [data-completed-more]').click()"); await sleep(200);
      assert.equal(await run("document.querySelectorAll('[data-agent-group=alpha] [data-completed-row]').length"), 65);
      report.checks.push('Completed list starts at 20 and expands fully in one click');
    }
    report.fullSessionReads = await run('groupLimitFixture.reads()');
    assert.equal(report.fullSessionReads, 0);
    report.checks.push('Listing and expansion do not fetch full transcripts');
    // Reset component state for matching narrow and horizontal captures.
    await win.reload(); await sleep(1500);
    win.setContentSize(480, 1100); await sleep(300);
    await run("document.querySelector('[aria-label=\"Open agent list\"]').click()");
    // Frame the end of Alpha's mounted rows: its Show more, or (before) its 20th card.
    const frameAlphaEnd = (block) => run(`(document.querySelector('[data-agent-group=alpha] [data-agent-more]') || document.querySelectorAll('[data-agent-group=alpha] [data-agent-card]')[19]).scrollIntoView({ block: '${block}', inline: 'end' })`);
    await sleep(600); await frameAlphaEnd('center');
    report.narrowDrawerOpen = await run("document.querySelector('[aria-label=\"Open agent list\"]')?.getAttribute('aria-expanded') === 'true'");
    await shot('groups-narrow');
    if (limited) {
      const hit = await run(`(() => { const e = document.querySelector('[data-agent-more]'); const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()`);
      assert.ok(hit, 'Narrow Show more is hit-testable');
      report.checks.push('Narrow Show more is visible and hit-testable');
    }
    win.setContentSize(1440, 1100); await sleep(300);
    await run("document.querySelector('[aria-label=\"Show agents in a row\"]').click()");
    await sleep(300); await frameAlphaEnd('nearest');
    await shot('groups-horizontal');
    report.horizontal = await counts();
    assert.deepEqual(report.horizontal, report.initial);
    if (limited) {
      for (const groupBy of ['status', 'date', 'computer', 'none']) {
        await run(`groupLimitFixture.group(${JSON.stringify(groupBy)})`); await sleep(300);
        const grouped = await counts();
        assert.ok(Object.values(grouped).some(n => n === 20), groupBy + ' has a capped group');
        assert.ok(Object.values(grouped).every(n => n <= 20), groupBy + ' never exceeds the cap');
        await run("document.querySelector('[data-agent-more]').click()"); await sleep(200);
        assert.ok(Object.values(await counts()).some(n => n === 130), groupBy + ' expands fully');
      }
      report.checks.push('Activity, Date, Computer and None all cap at 20 and expand to 130');
    }
    assert.equal(win.isVisible(), false);
    report.checks.push('Horizontal and vertical layouts share the cap; window stayed hidden');
  } catch (error) { report.errors.push(String(error.stack || error)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.quit();
  app.on('will-quit', () => { fs.rmSync(path.join(out, 'profile'), { recursive: true, force: true }); });
  process.exitCode = report.errors.length ? 1 : 0;
});
