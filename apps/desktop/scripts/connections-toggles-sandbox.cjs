// Settings > Connections in a hidden window: every switch centred on its row (#2397).
// NEKKO_LAYOUT_FIXTURE=settings-customize-fixture.tsx NEKKO_LAYOUT_SANDBOX=connections-toggles-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
// With NEKKO_TEST_SOURCE (a baseline capture) the offsets are recorded, not enforced.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseline = !!process.env.NEKKO_TEST_SOURCE;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_window, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [], checks: {}, offsets: {} };
  const run = code => win.webContents.executeJavaScript(code, true);
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message.slice(0, 300)); });
  const shot = async name => {
    await sleep(400);
    // A never-shown window hands back its previous frame first: take one to
    // flush it, then the real one.
    await win.capturePage(undefined, { stayHidden: true });
    await sleep(300);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(name);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!window.settingsFixture && !!document.querySelector(".settings-nav")'); i++) await sleep(200);
    await sleep(800);
    for (const width of [1280, 600]) {
      win.setContentSize(width, 900);
      await sleep(300);
      // Chromium suspends rAF in a never-shown window: drain the navigation's mount
      // frames by hand (as settings-customize-sandbox does), then land on the section.
      await run(`(() => {
        const original = window.requestAnimationFrame;
        const pending = [];
        window.requestAnimationFrame = callback => { pending.push(callback); return pending.length; };
        try { settingsFixture.openSettingsGroup('connections'); while (pending.length) pending.shift()(performance.now()); }
        finally { window.requestAnimationFrame = original; }
      })()`);
      // All connections off at the top, the first group's rows under it. The
      // navigation's own scroll can still be settling, so repeat until it holds.
      const place = `(() => { const s = document.querySelector('.settings-content'); s.style.scrollBehavior = 'auto'; const t = document.querySelector('[aria-label="All connections off"]'); s.scrollTop += t.getBoundingClientRect().top - s.getBoundingClientRect().top - 80; return Math.round(t.getBoundingClientRect().top - s.getBoundingClientRect().top); })()`;
      for (let i = 0; i < 10 && await run(place) !== 80; i++) await sleep(300);
      await sleep(300);
      report.checks[`placed-${width}`] = await run(place) === 80;
      await shot(`connections-${width}`);
      // How far each switch's centre sits from the centre of its row's text.
      const offsets = JSON.parse(await run(`JSON.stringify((() => {
        const section = [...document.querySelectorAll('section')].find(e => e.querySelector('h2')?.textContent === 'Connections');
        return [...section.querySelectorAll('[role=switch]')].map(sw => {
          let row = sw.parentElement;
          while (row && !(row.children.length > 1 && row.firstElementChild.contains(sw) === false && getComputedStyle(row).display === 'flex')) row = row.parentElement;
          const text = row.firstElementChild.getBoundingClientRect();
          const s = sw.getBoundingClientRect();
          return { label: sw.getAttribute('aria-label'), offset: Math.round(((s.top + s.height / 2) - (text.top + text.height / 2)) * 10) / 10 };
        });
      })())`));
      report.offsets[width] = offsets;
      report.checks[`switches-${width}`] = offsets.length > 1;
      if (!baseline) report.checks[`centred-${width}`] = offsets.every(o => Math.abs(o.offset) <= 1);
      report.checks[`overflow-${width}`] = await run('document.documentElement.scrollWidth <= innerWidth');
    }
    report.hidden = !win.isVisible();
    if (!report.hidden || Object.values(report.checks).some(value => !value)) throw Error('Connections verification failed');
  } catch (error) {
    report.errors.push(String(error && error.stack || error));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ errors: report.errors, checks: report.checks, offsets: report.offsets }));
  win.destroy();
  app.exit(report.errors.length ? 1 : 0);
});
