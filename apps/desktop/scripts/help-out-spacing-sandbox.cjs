// Settings > Help out the Nekko Team in a hidden window: before/after evidence and spacing checks for #2624.
// NEKKO_LAYOUT_FIXTURE=settings-customize-fixture.tsx NEKKO_LAYOUT_SANDBOX=help-out-spacing-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
// Set NEKKO_HELP_OUT_BASELINE=1 to record the measurements without enforcing them (the unchanged renderer).
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseline = process.env.NEKKO_HELP_OUT_BASELINE === '1';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_window, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [], measured: {}, checks: {} };
  const run = code => win.webContents.executeJavaScript(code, true);
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message.slice(0, 300)); });
  const shot = async name => {
    await sleep(400);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(name);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!document.querySelector("[data-testid=github-star-support]")'); i++) await sleep(200);
    await sleep(800);
    for (const width of [1280, 600]) {
      win.setContentSize(width, 900);
      await sleep(300);
      await run(`(() => { const s = document.querySelector('.settings-content'); s.scrollTop = 0; })()`);
      await shot(`help-out-${width}`);
    }
    win.setContentSize(1280, 900);
    await sleep(300);
    // Space from the end of the usage-report section to the star block, the star heading's type, and the promise row gap.
    report.measured = JSON.parse(await run(`JSON.stringify((() => {
      const usage = document.getElementById('usage-reports');
      const star = document.querySelector('[data-testid=github-star-support]');
      const heading = star.querySelector('h2, h3');
      const sectionHeading = usage.querySelector('h2');
      const items = [...usage.querySelectorAll('li')].map(li => li.getBoundingClientRect());
      const css = getComputedStyle(heading);
      return {
        sectionGap: Math.round(star.getBoundingClientRect().top - usage.getBoundingClientRect().bottom),
        starHeading: { size: css.fontSize, weight: css.fontWeight, tag: heading.tagName },
        sectionHeading: { size: getComputedStyle(sectionHeading).fontSize, weight: getComputedStyle(sectionHeading).fontWeight },
        promiseGaps: items.slice(1).map((r, i) => Math.round(r.top - items[i].bottom)),
      };
    })())`));
    const m = report.measured;
    report.checks.sectionGap40 = m.sectionGap === 40;
    report.checks.starHeadingMatchesSection = m.starHeading.size === m.sectionHeading.size && m.starHeading.weight === m.sectionHeading.weight && m.sectionHeading.size === '16px' && m.sectionHeading.weight === '600';
    report.checks.promiseGaps8 = m.promiseGaps.length > 0 && m.promiseGaps.every(g => g === 8);
    report.checks.noOverflow = await run('document.documentElement.scrollWidth <= innerWidth');
    if (!baseline) for (const [name, ok] of Object.entries(report.checks)) if (!ok) report.errors.push(`Check failed: ${name}`);
  } catch (error) {
    report.errors.push(String(error && error.stack || error));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ errors: report.errors, measured: report.measured, checks: report.checks }));
  process.exitCode = report.captures.length && (baseline || report.errors.length === 0) ? 0 : 1;
  app.exit(process.exitCode);
});
