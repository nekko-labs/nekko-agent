const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 960, height: 850, show: false, focusable: false, x: -3000, y: -3000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], checks: [] };
  win.on('focus', () => report.errors.push('Sandbox took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error' && !e.message.startsWith('ResizeObserver loop')) report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  const clickCancel = () => run(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Cancel watcher');if(!b)throw Error('Missing button');b.click()})()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('!!window.watchFixture && !!document.querySelector("[data-session-id]")')); i++) await sleep(100);
    await sleep(700);
    await run('watchFixture.suggest()'); await sleep(350);
    assert.ok(await run(`document.querySelector('textarea')?.placeholder === 'Check the latest PR status.' || [...document.querySelectorAll('[data-placeholder]')].some(e => e.dataset.placeholder === 'Check the latest PR status.')`));
    await shot('desktop');
    const before = !!process.env.NEKKO_TEST_SOURCE;
    if (!before) {
      assert.equal(await run('document.querySelectorAll("[data-active-watch-chips] details").length'), 1);
      assert.equal(await run('document.body.innerText.includes("Continue work")'), false);
      await run('document.querySelector("[data-active-watch-chips] summary").click()');
      await sleep(150);
      assert.equal(await run('document.querySelector("[data-active-watch-chips] details").open'), true);
      await shot('expanded');
      await run('watchFixture.due()'); await sleep(200);
      assert.ok(await run('document.querySelector("[data-active-watch-chips]").innerText.includes("waiting for the chat")'));
      await shot('due');
      await clickCancel(); await sleep(200);
      assert.equal(await run('!!document.querySelector("[data-active-watch-chips]")'), false);
      report.checks.push('live watch without transcript; expand; pending delivery status; cancel removes chip; no response row');
      await shot('cancelled');
      // Reload synthetic seed, never mutate a real chat.
      await win.reload(); await sleep(800);
    }
    await run('watchFixture.suggest()'); await sleep(200);
    await run('watchFixture.compact()');
    win.setContentSize(390, 850); await sleep(400);
    await shot('narrow');
    assert.ok(await run('document.documentElement.scrollWidth <= innerWidth'));
    report.checks.push('390px document does not horizontally overflow');
    await run('watchFixture.unmount()'); await sleep(50);
    assert.equal(await run('watchFixture.events.size'), 0);
    report.checks.push('unmount releases all bridge event subscriptions');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
