// Real ChatPane, synthetic records, hidden window, no host or network access.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Run through layout-evidence-integration.cjs');
const baseline = process.env.NEKKO_TEST_LABEL === 'before';
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [] };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = (name, ok) => { report.checks.push({ name, passed: !!ok }); };
  const state = () => run(`(() => { const s = document.querySelector('[data-transcript-scroll]'); const b = [...document.querySelectorAll('button')].find(b => /(?:Jump|Scroll) to latest/.test(b.textContent)); const r = b?.getBoundingClientRect(); return { gap: s.scrollHeight - s.scrollTop - s.clientHeight, pill: !!b, fits: r ? r.left >= 0 && r.right <= innerWidth && r.bottom <= s.getBoundingClientRect().bottom : false }; })()`);
  const capture = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  try {
    await win.loadFile(path.join(out, 'index.html'));
    // Map the virtualized fixture off-screen so captures reflect its latest paint.
    // Non-focusable and outside every monitor; never touches the user's app.
    win.showInactive();
    await sleep(1800);
    for (const [label, width, height] of [['desktop', 1100, 720], ['narrow', 390, 844]]) {
      win.setContentSize(width, height);
      await run('integration.reset({ count: 16 })');
      await sleep(1500);
      check(label + ': hidden at latest', !(await state()).pill);
      await run("document.querySelector('[data-transcript-scroll]').scrollTop -= 900");
      await sleep(700);
      const away = await state();
      check(label + ': scrolled away', away.gap > 200);
      check(label + ': pill appears without new output', away.pill === !baseline);
      if (!baseline) check(label + ': pill stays inside viewport', away.fits);
      await capture(label + '-away');
      if (!baseline) {
        await run("[...document.querySelectorAll('button')].find(b => /Scroll to latest/.test(b.textContent)).click()");
        for (let i = 0; i < 12; i++) { await capture(label + '-motion-' + String(i).padStart(2, '0')); await sleep(80); }
        await sleep(500);
        const end = await state();
        check(label + ': click reaches latest', end.gap < 2);
        check(label + ': hidden after click', !end.pill);
        await run("document.querySelector('[data-transcript-scroll]').scrollTop -= 600");
        await sleep(500);
        check(label + ': reappears on next scroll up', (await state()).pill);
        await run("(() => { const s = document.querySelector('[data-transcript-scroll]'); s.scrollTop = s.scrollHeight; })()");
        await sleep(500);
        check(label + ': manual return hides pill', !(await state()).pill);
        await capture(label + '-latest');
      }
      await run('integration.reset({ count: 0 })'); await sleep(600);
      check(label + ': empty chat has no pill', !(await state()).pill);
    }
  } catch (error) { report.errors.push(String(error)); }
  report.success = report.errors.length === 0 && report.checks.every(c => c.passed);
  fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.exit(report.success ? 0 : 1);
});
