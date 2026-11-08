const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 960, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: {}, errors: [], captures: [] };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  try {
    for (const width of [960, 420]) {
      win.setContentSize(width, 800);
      await win.loadFile(path.join(out, 'index.html'));
      for (let i = 0; i < 80 && !await run('document.querySelectorAll("[data-provider-heading]").length === 3'); i++) await sleep(100);
      await sleep(400);
      report.checks['geometry' + width] = await run(`(() => { const el = document.querySelector('[role=listbox]').parentElement, r = el.getBoundingClientRect(); return { viewport: innerWidth, left: r.left, right: r.right, height: r.height, padding: getComputedStyle(el).padding, meters: el.querySelectorAll('[role=meter]').length, overflow: document.documentElement.scrollWidth > innerWidth }; })()`);
      assert.equal(report.checks['geometry' + width].overflow, false);
      assert.ok(report.checks['geometry' + width].right <= report.checks['geometry' + width].viewport - 15);
      if (process.env.NEKKO_TEST_LABEL === 'after') {
        assert.equal(report.checks['geometry' + width].height, 500);
        assert.equal(report.checks['geometry' + width].padding, '12px');
        assert.equal(report.checks['geometry' + width].meters, 4);
        assert.equal(await run(`document.querySelector('[data-provider-group="gpt"] [role=meter]').getAttribute('aria-valuenow')`), '62');
        assert.equal(await run(`document.querySelector('[data-provider-group="claude"] [role=meter]').getAttribute('aria-valuenow')`), '85');
        assert.equal(await run(`document.querySelectorAll('[data-provider-group="local"] [role=meter]').length`), 0);
      }
      await shot('picker-' + width);
      if (process.env.NEKKO_TEST_LABEL === 'after') {
        await run('window.pickerFixture.emit()'); await sleep(100);
        assert.equal(await run(`document.querySelector('[data-provider-group="gpt"] [role=meter]').getAttribute('aria-valuenow')`), '93');
      }
      await run(`document.querySelector('[role=listbox]').scrollTop = 10000`);
      await sleep(150); await shot('picker-bottom-' + width);
      await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      assert.equal(await run(`!!document.querySelector('[role=listbox]')`), false);
      await run(`document.querySelector('[data-asks-first]').click()`);
      await sleep(200); await shot('permissions-' + width);
      await run(`Array.from(document.querySelectorAll('[role=menuitemradio]')).find(e => e.textContent.includes('Always ask')).click()`);
      await sleep(100);
      assert.equal(await run(`document.querySelector('[data-asks-first]').dataset.asksFirst`), 'ask');
      await run(`document.querySelector('[aria-haspopup=listbox]').click()`);
      await sleep(200);
      await run(`Array.from(document.querySelectorAll('[role=group] button')).find(e => e.textContent === 'Local').click()`);
      await sleep(100);
      assert.equal(await run(`document.querySelectorAll('[data-provider-heading]').length`), 1);
      await run(`document.querySelector('[role=option]').click()`);
      assert.equal(await run('window.pickerFixture.picked'), 'local-0');
    }
    report.checks.hidden = !win.isVisible();
    assert.ok(report.checks.hidden);
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.exit(report.errors.length ? 1 : 0);
});
